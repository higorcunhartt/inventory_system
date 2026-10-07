import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

process.env.JWT_SECRET = 'x'.repeat(48);
process.env.NETLIFY_DEV = 'true'; // e-mail MFA vai para o console
delete process.env.RESEND_API_KEY;
delete process.env.SMTP_HOST;

const { setSql } = await import('../netlify/lib/db.ts');
const { handle } = await import('../netlify/lib/app.ts');
const { hashPassword } = await import('../netlify/lib/auth.ts');

export const db = new PGlite();
setSql(async (s, ...v) => (await db.query(s.reduce((a, x, i) => a + '$' + i + x), v)).rows as any);

export let lastCode = '';
const origLog = console.log;
console.log = (...a: unknown[]) => {
  const m = String(a[0]).match(/\[DEV\] Código MFA para .*: (\d{6})/);
  if (m) lastCode = m[1];
  else origLog(...a);
};
export const quietErrors = () => {
  const o = console.error;
  console.error = () => {};
  return () => (console.error = o);
};

export async function loadSchema() {
  const { splitSql } = await import('../scripts/sql-split.mjs');
  for (const stmt of splitSql(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'))) await db.query(stmt);
}

export async function addUser(email: string, name: string, role: 'admin' | 'operator', password = 'senha-super-segura', mustChange = false) {
  const r = await db.query(
    `insert into users (email, name, password_hash, role, must_change_password) values ($1, $2, $3, $4, $5) returning id`,
    [email, name, await hashPassword(password), role, mustChange],
  );
  return (r.rows[0] as any).id as string;
}

export async function call(method: string, path: string, body?: unknown, cookie?: string, extra: Record<string, string> = {}) {
  const res = await handle(
    new Request('http://localhost/api' + path, {
      method,
      headers: {
        'x-requested-with': 'inventory-web',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        ...extra,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, setCookie: res.headers.get('set-cookie'), headers: res.headers };
}

export async function login(email: string, password = 'senha-super-segura', extra: Record<string, string> = {}) {
  const a = await call('POST', '/auth/login', { email, password }, undefined, extra);
  if (a.status !== 200) throw new Error(`login falhou: ${a.status} ${JSON.stringify(a.data)}`);
  const b = await call('POST', '/auth/verify', { mfaToken: a.data.mfaToken, code: lastCode }, undefined, extra);
  if (b.status !== 200) throw new Error(`verify falhou: ${b.status} ${JSON.stringify(b.data)}`);
  return b.setCookie!.split(';')[0];
}
