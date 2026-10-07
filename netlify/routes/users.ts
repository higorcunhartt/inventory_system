import { sql } from '../lib/db.ts';
import { HttpError, json, readJson, type Route } from '../lib/http.ts';
import { hashPassword, requireReauth, requireUser } from '../lib/auth.ts';
import { corporateEmail, password, reqStr } from '../lib/validate.ts';

const ROLES = ['admin', 'operator'];

const toUser = (u: Record<string, any>) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  active: u.active,
  mustChangePassword: u.must_change_password,
  createdAt: u.created_at,
});

export const userRoutes: Route[] = [
  [
    'GET',
    '/users',
    async ({ req }) => {
      await requireUser(req, { roles: ['admin'] });
      const rows = await sql`select id, email, name, role, active, must_change_password, created_at from users order by name`;
      return json({ users: rows.map(toUser) });
    },
  ],

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
      const pwd = password(body.password);
      await requireReauth(me.id, body.confirmPassword);
      const hash = await hashPassword(pwd);
      const rows = await sql`insert into users (email, name, password_hash, role, must_change_password)
                             values (${mail}, ${name}, ${hash}, ${role}, true)
                             on conflict (email) do nothing
                             returning id, email, name, role, active, must_change_password, created_at`;
      if (!rows.length) throw new HttpError(409, 'Já existe um usuário com este e-mail');
      return json({ user: toUser(rows[0]) }, 201);
    },
  ],

  [
    'PATCH',
    '/users/:id',
    async ({ req, params }) => {
      const me = await requireUser(req, { roles: ['admin'] });
      const body = await readJson(req);
      const hasName = body.name !== undefined;
      const hasRole = body.role !== undefined;
      const hasActive = body.active !== undefined;
      const hasPass = body.password !== undefined;
      if (hasRole && !ROLES.includes(body.role)) throw new HttpError(400, 'Perfil inválido');
      if (hasActive && typeof body.active !== 'boolean') throw new HttpError(400, 'Valor inválido: ativo');
      if (params.id === me.id && (hasRole || hasActive)) {
        throw new HttpError(400, 'Você não pode alterar seu próprio perfil ou status');
      }
      const name = hasName ? reqStr(body.name, 'nome', 120) : null;
      const newPassword = hasPass ? password(body.password) : null;
      // Mudar papel, status ou senha de alguém exige confirmar a senha do administrador.
      if (hasRole || hasActive || hasPass) await requireReauth(me.id, body.confirmPassword);
      const hash = newPassword ? await hashPassword(newPassword) : null;
      let rows;
      try {
        rows = await sql`update users set
          name = case when ${hasName}::boolean then ${name}::text else name end,
          role = case when ${hasRole}::boolean then ${body.role ?? null}::text else role end,
          active = case when ${hasActive}::boolean then ${body.active ?? null}::boolean else active end,
          password_hash = case when ${hasPass}::boolean then ${hash}::text else password_hash end,
          must_change_password = case when ${hasPass}::boolean then true else must_change_password end,
          token_version = case when ${hasPass || hasRole || hasActive}::boolean then token_version + 1 else token_version end,
          failed_attempts = case when ${hasPass}::boolean then 0 else failed_attempts end,
          locked_until = case when ${hasPass}::boolean then null else locked_until end
        where id = ${params.id}
        returning id, email, name, role, active, must_change_password, created_at`;
      } catch (err: any) {
        // Gatilho do banco: sempre deve restar ao menos um administrador ativo
        if (String(err?.message).includes('last_admin')) throw new HttpError(409, 'Deve existir ao menos um administrador ativo');
        throw err;
      }
      if (!rows.length) throw new HttpError(404, 'Usuário não encontrado');
      return json({ user: toUser(rows[0]) });
    },
  ],
];
