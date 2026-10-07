import { sql } from './db.ts';

/**
 * IP do cliente. Em produção o Netlify envia `x-nf-client-connection-ip` (não forjável pelo cliente);
 * o fallback para `x-forwarded-for` só existe para desenvolvimento local e testes.
 */
export function clientIp(req: Request): string {
  return (
    req.headers.get('x-nf-client-connection-ip') ||
    (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown'
  );
}

/**
 * Registra uma tentativa e devolve o total na janela atual.
 * É uma única instrução SQL (upsert), logo atômica: requisições simultâneas não escapam da contagem.
 */
export async function hit(key: string, windowSeconds: number): Promise<number> {
  const interval = `${Math.floor(windowSeconds)} seconds`;
  const [r] = await sql`
    insert into rate_limits (key, count, reset_at)
    values (${key}, 1, now() + ${interval}::interval)
    on conflict (key) do update set
      count = case when rate_limits.reset_at <= now() then 1 else rate_limits.count + 1 end,
      reset_at = case when rate_limits.reset_at <= now() then now() + ${interval}::interval else rate_limits.reset_at end
    returning count`;
  return r.count;
}

/** Devolve uma tentativa (usado quando a tentativa teve sucesso). */
export async function refund(key: string): Promise<void> {
  await sql`update rate_limits set count = greatest(count - 1, 0) where key = ${key}`;
}

export async function clearKey(key: string): Promise<void> {
  await sql`delete from rate_limits where key = ${key}`;
}

/** Limpeza oportunista de contadores antigos. */
export async function purgeExpired(): Promise<void> {
  await sql`delete from rate_limits where reset_at < now() - interval '1 day'`;
}
