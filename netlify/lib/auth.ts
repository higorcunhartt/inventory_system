import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { sql } from './db.ts';
import { HttpError } from './http.ts';

const SESSION_SECONDS = 8 * 60 * 60;
const COOKIE = 'session';

export type SessionUser = { id: string; email: string; name: string; role: 'admin' | 'operator'; mustChangePassword: boolean };

function secretKey() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) throw new Error('JWT_SECRET ausente ou com menos de 32 caracteres');
  return new TextEncoder().encode(s);
}

async function sign(userId: string, purpose: 'session' | 'mfa', seconds: number) {
  return new SignJWT({ purpose })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer('inventory-system')
    .setIssuedAt()
    .setExpirationTime(`${seconds}s`)
    .sign(secretKey());
}

async function verify(token: string, purpose: 'session' | 'mfa'): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { issuer: 'inventory-system', algorithms: ['HS256'] });
    if (payload.purpose !== purpose || !payload.sub) throw new Error('purpose');
    return payload.sub;
  } catch {
    throw new HttpError(
      401,
      purpose === 'mfa' ? 'Sessão de verificação expirada. Faça login novamente.' : 'Não autenticado',
      'UNAUTHENTICATED',
    );
  }
}

export const signMfaToken = (userId: string) => sign(userId, 'mfa', 10 * 60);
export const verifyMfaToken = (token: string) => verify(token, 'mfa');

export async function sessionCookie(userId: string) {
  const token = await sign(userId, 'session', SESSION_SECONDS);
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
  const id = await verify(token, 'session');
  const [u] = await sql`select id, email, name, role, active, must_change_password from users where id = ${id}`;
  if (!u || !u.active) throw new HttpError(401, 'Não autenticado', 'UNAUTHENTICATED');
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
