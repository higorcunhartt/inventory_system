import { createHmac, randomBytes } from 'node:crypto';
import { sql } from './db.ts';
import { HttpError } from './http.ts';
import { hit } from './ratelimit.ts';

export type LinkKind = 'invite' | 'reset';
const TTL_SECONDS: Record<LinkKind, number> = { invite: 24 * 3600, reset: 3600 };

// O token só existe no e-mail do usuário; no banco fica apenas um HMAC (chave derivada, separada do JWT e do MFA).
function hashToken(token: string): string {
  const key = createHmac('sha256', process.env.JWT_SECRET || '').update('inventory-system:password-link:v1').digest();
  return createHmac('sha256', key).update(token).digest('hex');
}

/** Endereço público do sistema. Prefira APP_URL; o fallback usa a origem da própria requisição. */
export function appUrl(req: Request): string {
  const configured = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
  return configured || new URL(req.url).origin;
}

/**
 * Cria um link de uso único para definir a senha e invalida os links anteriores do mesmo usuário.
 * O token vai no fragmento (#t=...), que o navegador não envia ao servidor nem a logs e referrers.
 */
export async function issueLink(req: Request, userId: string, kind: LinkKind): Promise<string> {
  if ((await hit(`pwlink:${userId}`, 86400)) > 8) throw new HttpError(429, 'Muitos links solicitados para este usuário hoje. Tente novamente amanhã.');
  await sql`update password_tokens set used_at = now() where user_id = ${userId} and used_at is null`;
  const token = randomBytes(32).toString('base64url');
  const interval = `${TTL_SECONDS[kind]} seconds`;
  await sql`insert into password_tokens (user_id, token_hash, purpose, expires_at)
            values (${userId}, ${hashToken(token)}, ${kind}, now() + ${interval}::interval)`;
  return `${appUrl(req)}/definir-senha#t=${token}`;
}

/** Consome o token de forma atômica (uso único). Devolve o dono e a finalidade, ou null se inválido, usado ou expirado. */
export async function consumeToken(token: string): Promise<{ userId: string; purpose: LinkKind } | null> {
  const rows = await sql`update password_tokens set used_at = now()
                         where token_hash = ${hashToken(token)} and used_at is null and expires_at > now()
                         returning user_id, purpose`;
  return rows[0] ? { userId: rows[0].user_id, purpose: rows[0].purpose } : null;
}

export async function revokeLinks(userId: string): Promise<void> {
  await sql`update password_tokens set used_at = now() where user_id = ${userId} and used_at is null`;
}
