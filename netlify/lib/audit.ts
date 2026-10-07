import { sql } from './db.ts';
import { clientIp } from './ratelimit.ts';

type Actor = { id?: string | null; email?: string | null } | null;

/**
 * Registro de auditoria somente de inserção (sem chave estrangeira nem exclusão em cascata: o registro
 * sobrevive à exclusão do dado e do usuário). NUNCA passe senhas, códigos ou tokens em `detail`.
 */
export async function audit(
  req: Request,
  actor: Actor,
  action: string,
  opts: { target?: string | null; result?: 'ok' | 'fail' | 'blocked'; detail?: Record<string, unknown> } = {},
): Promise<void> {
  try {
    const detail = opts.detail ? JSON.stringify(opts.detail).slice(0, 2000) : null;
    await sql`insert into audit_log (actor_id, actor_email, action, target, result, ip, user_agent, detail)
              values (${actor?.id ?? null}, ${actor?.email ?? null}, ${action}, ${opts.target?.slice(0, 254) ?? null},
                      ${opts.result ?? 'ok'}, ${clientIp(req)}, ${(req.headers.get('user-agent') || '').slice(0, 160) || null},
                      ${detail}::jsonb)`;
  } catch (err) {
    // A falha de auditoria não deve derrubar a requisição, mas precisa ser visível nos logs do servidor.
    console.error('Falha ao gravar auditoria:', action, err);
  }
}
