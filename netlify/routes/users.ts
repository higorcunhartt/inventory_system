import { randomBytes } from 'node:crypto';
import { sql } from '../lib/db.ts';
import { HttpError, json, readJson, type Route } from '../lib/http.ts';
import { hashPassword, requireReauth, requireUser } from '../lib/auth.ts';
import { audit } from '../lib/audit.ts';
import { sendPasswordLinkEmail } from '../lib/mail.ts';
import { issueLink, revokeLinks } from '../lib/password-links.ts';
import { corporateEmail, reqStr, uuid } from '../lib/validate.ts';

const ROLES = ['admin', 'operator'];

const toUser = (u: Record<string, any>) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  active: u.active,
  mustChangePassword: u.must_change_password,
  pendingLink: Boolean(u.pending_link),
  createdAt: u.created_at,
});

/** Gera o link de definição de senha e envia por e-mail. Devolve false se o envio falhar (o usuário continua criado). */
async function sendLink(req: Request, actor: { id: string; email: string }, user: { id: string; email: string; name: string }, kind: 'invite' | 'reset') {
  try {
    const link = await issueLink(req, user.id, kind);
    await sendPasswordLinkEmail(user.email, user.name, link, kind);
    await audit(req, actor, 'password_link_sent', { target: user.email, detail: { userId: user.id, kind } });
    return true;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error('Falha ao enviar link de senha:', err);
    await audit(req, actor, 'password_link_failed', { target: user.email, result: 'fail', detail: { userId: user.id, kind } });
    return false;
  }
}

export const userRoutes: Route[] = [
  [
    'GET',
    '/users',
    async ({ req }) => {
      await requireUser(req, { roles: ['admin'] });
      const rows = await sql`
        select id, email, name, role, active, must_change_password, created_at,
               exists (select 1 from password_tokens t where t.user_id = users.id and t.used_at is null and t.expires_at > now()) as pending_link
        from users order by name`;
      return json({ users: rows.map(toUser) });
    },
  ],

  // Cria o usuário SEM senha: ele recebe um link de uso único (24 h) para definir a própria senha.
  [
    'POST',
    '/users',
    async ({ req }) => {
      const me = await requireUser(req, { roles: ['admin'] });
      const body = await readJson(req);
      const name = reqStr(body.name, 'nome', 120);
      const mail = corporateEmail(body.email);
      const role = body.role ?? 'operator';
      if (!ROLES.includes(role)) throw new HttpError(400, 'Perfil inválido');
      if (body.password !== undefined) throw new HttpError(400, 'Não informe senha: o usuário receberá um link para definir a própria senha.');
      await requireReauth(req, me.id, body.confirmPassword);
      // Senha aleatória e desconhecida (ninguém, nem o administrador, consegue usá-la): a conta só ativa pelo link.
      const unusable = await hashPassword(randomBytes(32).toString('hex'));
      const rows = await sql`insert into users (email, name, password_hash, role, must_change_password)
                             values (${mail}, ${name}, ${unusable}, ${role}, true)
                             on conflict (email) do nothing
                             returning id, email, name, role, active, must_change_password, created_at`;
      if (!rows.length) throw new HttpError(409, 'Já existe um usuário com este e-mail');
      await audit(req, me, 'user_created', { target: mail, detail: { role, userId: rows[0].id } });
      const emailSent = await sendLink(req, me, rows[0] as any, 'invite');
      return json({ user: toUser(rows[0]), emailSent }, 201);
    },
  ],

  // Reenvia/gera um novo link (24 h) e invalida os anteriores. Substitui "o administrador define a senha de outra pessoa".
  [
    'POST',
    '/users/:id/invite',
    async ({ req, params }) => {
      const me = await requireUser(req, { roles: ['admin'] });
      const targetId = uuid(params.id);
      const body = await readJson(req);
      await requireReauth(req, me.id, body.confirmPassword);
      const [u] = await sql`select id, email, name, active from users where id = ${targetId}`;
      if (!u) throw new HttpError(404, 'Usuário não encontrado');
      if (!u.active) throw new HttpError(409, 'Usuário inativo: reative-o antes de enviar o link');
      const emailSent = await sendLink(req, me, u as any, 'invite');
      if (!emailSent) throw new HttpError(502, 'Não foi possível enviar o e-mail. Tente novamente.');
      return json({ ok: true, emailSent });
    },
  ],

  [
    'PATCH',
    '/users/:id',
    async ({ req, params }) => {
      const me = await requireUser(req, { roles: ['admin'] });
      const targetId = uuid(params.id);
      const body = await readJson(req);
      if (body.password !== undefined) {
        throw new HttpError(400, 'O administrador não define senhas. Use "Enviar link de senha" para que a pessoa defina a própria.');
      }
      const hasName = body.name !== undefined;
      const hasRole = body.role !== undefined;
      const hasActive = body.active !== undefined;
      if (hasRole && !ROLES.includes(body.role)) throw new HttpError(400, 'Perfil inválido');
      if (hasActive && typeof body.active !== 'boolean') throw new HttpError(400, 'Valor inválido: ativo');
      if (targetId === me.id && (hasRole || hasActive)) {
        throw new HttpError(400, 'Você não pode alterar seu próprio perfil ou status');
      }
      const name = hasName ? reqStr(body.name, 'nome', 120) : null;
      // Mudar papel ou status de alguém exige confirmar a senha do administrador.
      if (hasRole || hasActive) await requireReauth(req, me.id, body.confirmPassword);
      let rows;
      try {
        rows = await sql`update users set
          name = case when ${hasName}::boolean then ${name}::text else name end,
          role = case when ${hasRole}::boolean then ${body.role ?? null}::text else role end,
          active = case when ${hasActive}::boolean then ${body.active ?? null}::boolean else active end,
          token_version = case when ${hasRole || hasActive}::boolean then token_version + 1 else token_version end
        where id = ${targetId}
        returning id, email, name, role, active, must_change_password, created_at`;
      } catch (err: any) {
        // Gatilho do banco: sempre deve restar ao menos um administrador ativo
        if (String(err?.message).includes('last_admin')) throw new HttpError(409, 'Deve existir ao menos um administrador ativo');
        throw err;
      }
      if (!rows.length) throw new HttpError(404, 'Usuário não encontrado');
      if (hasActive && body.active === false) await revokeLinks(targetId);
      await audit(req, me, 'user_updated', {
        target: rows[0].email,
        detail: { userId: rows[0].id, name: hasName || undefined, role: hasRole ? body.role : undefined, active: hasActive ? body.active : undefined },
      });
      return json({ user: toUser(rows[0]) });
    },
  ],
];
