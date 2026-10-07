import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { sql } from './db.ts';
import { HttpError } from './http.ts';
import { clearKey, hit } from './ratelimit.ts';
import { audit } from './audit.ts';

const SESSION_SECONDS = 8 * 60 * 60;
const COOKIE = 'session';

export type SessionUser = { id: string; email: string; name: string; role: 'admin' | 'operator'; mustChangePassword: boolean };

function secretKey() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) throw new Error('JWT_SECRET ausente ou com menos de 32 caracteres');
  return new TextEncoder().encode(s);
}

async function sign(userId: string, purpose: 'session' | 'mfa', seconds: number, tokenVersion = 0) {
  return new SignJWT({ purpose, tv: tokenVersion })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer('inventory-system')
    .setIssuedAt()
    .setExpirationTime(`${seconds}s`)
    .sign(secretKey());
}

async function verifyClaims(token: string, purpose: 'session' | 'mfa'): Promise<{ sub: string; tv: number }> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { issuer: 'inventory-system', algorithms: ['HS256'] });
    if (payload.purpose !== purpose || !payload.sub) throw new Error('purpose');
    return { sub: payload.sub, tv: typeof payload.tv === 'number' ? payload.tv : -1 };
  } catch {
    throw new HttpError(
      401,
      purpose === 'mfa' ? 'Sessão de verificação expirada. Faça login novamente.' : 'Não autenticado',
      'UNAUTHENTICATED',
    );
  }
}

export const signMfaToken = (userId: string) => sign(userId, 'mfa', 10 * 60);
export const verifyMfaToken = async (token: string) => (await verifyClaims(token, 'mfa')).sub;

export async function sessionCookie(userId: string, tokenVersion: number) {
  const token = await sign(userId, 'session', SESSION_SECONDS, tokenVersion);
  const secure = process.env.NETLIFY_DEV === 'true' ? '' : '; Secure';
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}${secure}`;
}

export const clearCookie = () => `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

function readCookie(req: Request): string | null {
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return null;
}

export async function requireUser(
  req: Request,
  opts: { roles?: Array<'admin' | 'operator'>; allowPasswordChange?: boolean } = {},
): Promise<SessionUser> {
  const token = readCookie(req);
  if (!token) throw new HttpError(401, 'Não autenticado', 'UNAUTHENTICATED');
  const { sub: id, tv } = await verifyClaims(token, 'session');
  const [u] = await sql`select id, email, name, role, active, must_change_password, token_version from users where id = ${id}`;
  // token_version diferente = sessão revogada (logout, troca/reset de senha, desativação ou mudança de papel)
  if (!u || !u.active || u.token_version !== tv) throw new HttpError(401, 'Não autenticado', 'UNAUTHENTICATED');
  if (u.must_change_password && !opts.allowPasswordChange) {
    throw new HttpError(403, 'Altere sua senha para continuar', 'PASSWORD_CHANGE_REQUIRED');
  }
  if (opts.roles && !opts.roles.includes(u.role)) throw new HttpError(403, 'Sem permissão para esta ação');
  return { id: u.id, email: u.email, name: u.name, role: u.role, mustChangePassword: u.must_change_password };
}

export const hashPassword = (p: string) => bcrypt.hash(p, 12);
export const checkPassword = (p: string, hash: string) => bcrypt.compare(p, hash);

// Mantém o tempo de resposta do login quando o e-mail não existe.
let dummyHash: string | undefined;
export const getDummyHash = () => (dummyHash ??= bcrypt.hashSync(randomUUID(), 12));

export const generateCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

export function hashCode(code: string, userId: string) {
  return createHmac('sha256', secretKey()).update(`${userId}:${code}`).digest('hex');
}

export function codesMatch(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Revoga todas as sessões do usuário e devolve a nova versão. */
export async function bumpTokenVersion(userId: string): Promise<number> {
  const [r] = await sql`update users set token_version = token_version + 1 where id = ${userId} returning token_version`;
  return r.token_version;
}

/** Id do usuário dono do cookie de sessão, se o cookie for válido e não revogado (sem lançar erro). */
export async function currentSessionUserId(req: Request): Promise<string | null> {
  try {
    const token = readCookie(req);
    if (!token) return null;
    const { sub, tv } = await verifyClaims(token, 'session');
    const [u] = await sql`select token_version from users where id = ${sub}`;
    return u && u.token_version === tv ? sub : null;
  } catch {
    return null;
  }
}

/**
 * Reautenticação ("step-up") para ações de alto risco: exige a senha do próprio usuário no pedido.
 * Quem só possui um cookie de sessão roubado não consegue concluir a ação.
 */
export async function requireReauth(req: Request, userId: string, confirmPassword: unknown): Promise<void> {
  if (typeof confirmPassword !== 'string' || !confirmPassword) {
    throw new HttpError(403, 'Confirme sua senha para continuar', 'REAUTH_REQUIRED');
  }
  if ((await hit(`stepup:${userId}`, 15 * 60)) > 5) throw new HttpError(429, 'Muitas tentativas. Tente novamente em alguns minutos.');
  const [u] = await sql`select password_hash from users where id = ${userId}`;
  if (!u || !(await checkPassword(confirmPassword, u.password_hash))) {
    await audit(req, { id: userId }, 'reauth_failed', { result: 'fail' });
    throw new HttpError(403, 'Senha de confirmação incorreta', 'REAUTH_FAILED');
  }
  await clearKey(`stepup:${userId}`);
}
