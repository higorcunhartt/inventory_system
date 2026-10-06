import { sql } from '../lib/db.ts';
import { HttpError, json, readJson, type Route } from '../lib/http.ts';
import {
  checkPassword,
  clearCookie,
  codesMatch,
  generateCode,
  getDummyHash,
  hashCode,
  hashPassword,
  requireUser,
  sessionCookie,
  signMfaToken,
  verifyMfaToken,
} from '../lib/auth.ts';
import { sendMfaEmail } from '../lib/mail.ts';
import { email, password, reqStr } from '../lib/validate.ts';

const MAX_MFA_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 30;

const maskEmail = (e: string) => e.replace(/^(.).*(@.*)$/, '$1***$2');

async function issueMfa(user: { id: string; email: string; name: string }) {
  const code = generateCode();
  await sql`update mfa_codes set consumed = true where user_id = ${user.id} and not consumed`;
  await sql`insert into mfa_codes (user_id, code_hash, expires_at)
            values (${user.id}, ${hashCode(code, user.id)}, now() + interval '10 minutes')`;
  try {
    await sendMfaEmail(user.email, user.name, code);
  } catch (err) {
    console.error('Erro ao enviar MFA:', err);
    throw new HttpError(502, 'Não foi possível enviar o código por e-mail. Tente novamente.');
  }
}

export const authRoutes: Route[] = [
  [
    'POST',
    '/auth/login',
    async ({ req }) => {
      const body = await readJson(req);
      const mail = email(body.email);
      const pass = reqStr(body.password, 'senha', 128);

      const [u] = await sql`select id, email, name, password_hash, active, locked_until from users where email = ${mail}`;
      if (u?.locked_until && new Date(u.locked_until) > new Date()) {
        throw new HttpError(429, 'Muitas tentativas. Tente novamente em alguns minutos.');
      }
      const ok = await checkPassword(pass, u?.password_hash ?? getDummyHash());
      if (!u || !u.active || !ok) {
        if (u) {
          await sql`update users set
                      failed_attempts = case when failed_attempts + 1 >= 5 then 0 else failed_attempts + 1 end,
                      locked_until = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes' else locked_until end
                    where id = ${u.id}`;
        }
        throw new HttpError(401, 'E-mail ou senha inválidos');
      }
      await sql`update users set failed_attempts = 0, locked_until = null where id = ${u.id}`;
      await issueMfa(u as any);
      return json({ mfaToken: await signMfaToken(u.id), email: maskEmail(u.email) });
    },
  ],

  [
    'POST',
    '/auth/resend',
    async ({ req }) => {
      const body = await readJson(req);
      const userId = await verifyMfaToken(reqStr(body.mfaToken, 'token', 2000));
      const [u] = await sql`select id, email, name, active from users where id = ${userId}`;
      if (!u || !u.active) throw new HttpError(401, 'Não autenticado');
      const [recent] = await sql`select 1 as x from mfa_codes
                                 where user_id = ${userId} and created_at > now() - ${RESEND_COOLDOWN_SECONDS + ' seconds'}::interval`;
      if (recent) throw new HttpError(429, `Aguarde ${RESEND_COOLDOWN_SECONDS} segundos para reenviar o código.`);
      await issueMfa(u as any);
      return json({ ok: true });
    },
  ],

  [
    'POST',
    '/auth/verify',
    async ({ req }) => {
      const body = await readJson(req);
      const userId = await verifyMfaToken(reqStr(body.mfaToken, 'token', 2000));
      const code = reqStr(body.code, 'código', 6);
      if (!/^\d{6}$/.test(code)) throw new HttpError(400, 'O código deve ter 6 dígitos');

      const [row] = await sql`select id, code_hash from mfa_codes
                              where user_id = ${userId} and not consumed and expires_at > now()
                              order by created_at desc limit 1`;
      if (!row) throw new HttpError(400, 'Código expirado. Solicite um novo código.');
      const [{ attempts }] = await sql`update mfa_codes set attempts = attempts + 1 where id = ${row.id} returning attempts`;
      if (attempts > MAX_MFA_ATTEMPTS) {
        await sql`update mfa_codes set consumed = true where id = ${row.id}`;
        throw new HttpError(429, 'Muitas tentativas incorretas. Solicite um novo código.');
      }
      if (!codesMatch(hashCode(code, userId), row.code_hash)) throw new HttpError(401, 'Código incorreto');

      const consumed = await sql`update mfa_codes set consumed = true where id = ${row.id} and not consumed returning id`;
      if (!consumed.length) throw new HttpError(400, 'Código já utilizado');

      const [u] = await sql`select id, email, name, role, active, must_change_password from users where id = ${userId}`;
      if (!u || !u.active) throw new HttpError(401, 'Não autenticado');
      return json(
        { user: { id: u.id, email: u.email, name: u.name, role: u.role, mustChangePassword: u.must_change_password } },
        200,
        { 'set-cookie': await sessionCookie(u.id) },
      );
    },
  ],

  [
    'GET',
    '/auth/me',
    async ({ req }) => json({ user: await requireUser(req, { allowPasswordChange: true }) }),
  ],

  ['POST', '/auth/logout', async () => json({ ok: true }, 200, { 'set-cookie': clearCookie() })],

  [
    'POST',
    '/auth/change-password',
    async ({ req }) => {
      const user = await requireUser(req, { allowPasswordChange: true });
      const body = await readJson(req);
      const current = reqStr(body.currentPassword, 'senha atual', 128);
      const next = password(body.newPassword);
      if (current === next) throw new HttpError(400, 'A nova senha deve ser diferente da atual');
      const [u] = await sql`select password_hash from users where id = ${user.id}`;
      if (!(await checkPassword(current, u.password_hash))) throw new HttpError(400, 'Senha atual incorreta');
      await sql`update users set password_hash = ${await hashPassword(next)}, must_change_password = false where id = ${user.id}`;
      return json({ ok: true });
    },
  ],
];
