import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

process.env.JWT_SECRET = 'x'.repeat(48);
process.env.NETLIFY_DEV = 'true'; // e-mail MFA vai para o console
delete process.env.RESEND_API_KEY;
process.env.ALLOWED_EMAIL_DOMAINS = 'x.com';

const { setSql } = await import('../netlify/lib/db.ts');
const { handle } = await import('../netlify/lib/app.ts');
const { hashPassword } = await import('../netlify/lib/auth.ts');

const db = new PGlite();
setSql(async (s, ...v) => (await db.query(s.reduce((a, x, i) => a + '$' + i + x), v)).rows as any);

let lastCode = '';
const origLog = console.log;
console.log = (...a: unknown[]) => {
  const m = String(a[0]).match(/\[DEV\] Código MFA para .*: (\d{6})/);
  if (m) lastCode = m[1];
  else origLog(...a);
};

async function call(method: string, path: string, body?: unknown, cookie?: string) {
  const res = await handle(
    new Request('http://localhost/api' + path, {
      method,
      headers: { 'x-requested-with': 'inventory-web', ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, setCookie: res.headers.get('set-cookie') };
}

async function login(email: string, password: string) {
  const a = await call('POST', '/auth/login', { email, password });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  const b = await call('POST', '/auth/verify', { mfaToken: a.data.mfaToken, code: lastCode });
  assert.equal(b.status, 200, JSON.stringify(b.data));
  return b.setCookie!.split(';')[0];
}

let admin = '';
let operator = '';

before(async () => {
  const { splitSql } = await import('../scripts/sql-split.mjs');
  for (const stmt of splitSql(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'))) {
    await db.query(stmt);
  }
  await db.query(`insert into users (email, name, password_hash, role) values ('admin@x.com', 'Admin', $1, 'admin')`, [await hashPassword('senha-super-segura')]);
  admin = await login('admin@x.com', 'senha-super-segura');
});

test('login: senha errada, MFA errado e acesso sem cookie', async () => {
  assert.equal((await call('POST', '/auth/login', { email: 'admin@x.com', password: 'errada-errada' })).status, 401);
  assert.equal((await call('POST', '/auth/login', { email: 'ninguem@x.com', password: 'errada-errada' })).status, 401);
  const a = await call('POST', '/auth/login', { email: 'admin@x.com', password: 'senha-super-segura' });
  const wrong = lastCode === '000000' ? '111111' : '000000';
  assert.equal((await call('POST', '/auth/verify', { mfaToken: a.data.mfaToken, code: wrong })).status, 401);
  assert.equal((await call('GET', '/lines')).status, 401);
  assert.equal((await call('GET', '/auth/me', undefined, admin)).data.user.role, 'admin');
});

test('código MFA bloqueia após 5 tentativas erradas', async () => {
  const a = await call('POST', '/auth/login', { email: 'admin@x.com', password: 'senha-super-segura' });
  const real = lastCode;
  const wrong = real === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/auth/verify', { mfaToken: a.data.mfaToken, code: wrong })).status, 401);
  assert.equal((await call('POST', '/auth/verify', { mfaToken: a.data.mfaToken, code: real })).status, 429);
});

test('admin cria operador que precisa trocar a senha', async () => {
  const c = await call('POST', '/users', { name: 'Operador', email: 'op@x.com', role: 'operator', password: 'senha-temporaria1', confirmPassword: 'senha-super-segura' }, admin);
  assert.equal(c.status, 201);
  assert.equal((await call('POST', '/users', { name: 'Dup', email: 'OP@x.com', password: 'senha-temporaria1', confirmPassword: 'senha-super-segura' }, admin)).status, 409);

  operator = await login('op@x.com', 'senha-temporaria1');
  const blocked = await call('GET', '/lines', undefined, operator);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.code, 'PASSWORD_CHANGE_REQUIRED');
  const changed = await call('POST', '/auth/change-password', { currentPassword: 'senha-temporaria1', newPassword: 'nova-senha-forte-1' }, operator);
  assert.equal(changed.status, 200);
  assert.equal((await call('GET', '/lines', undefined, operator)).status, 401); // sessão antiga revogada
  operator = changed.setCookie!.split(';')[0]; // token novo emitido na troca
  assert.equal((await call('GET', '/lines', undefined, operator)).status, 200);
  assert.equal((await call('GET', '/users', undefined, operator)).status, 403);
});

test('linhas: admin cadastra, operador só altera usuário/data', async () => {
  const c = await call('POST', '/lines', { number: '(11) 98765-4321', carrier: 'Vivo', lineType: 'DADOS_VOZ', account: '0371235565', assigneeName: 'Maria', project: 'Obra A', deliveryDate: '2026-01-15' }, admin);
  assert.equal(c.status, 201, JSON.stringify(c.data));
  const id = c.data.line.id;
  assert.equal(c.data.line.number, '11987654321');
  assert.equal(c.data.line.account, '0371235565');
  assert.equal(c.data.line.deliveryDate, '2026-01-15');
  assert.equal((await call('POST', '/lines', { number: '11987654321', carrier: 'Vivo', lineType: 'DADOS' }, admin)).status, 409);
  assert.equal((await call('POST', '/lines', { number: '11987654321', carrier: 'Vivo', lineType: 'DADOS' }, operator)).status, 403);

  const ok = await call('PATCH', `/lines/${id}`, { assigneeName: 'João', deliveryDate: '2026-03-01' }, operator);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.line.assigneeName, 'João');
  assert.equal(ok.data.line.project, 'Obra A');
  assert.equal((await call('PATCH', `/lines/${id}`, { project: 'Obra B' }, operator)).status, 403);
  assert.equal((await call('PATCH', `/lines/${id}`, { carrier: 'TIM' }, operator)).status, 403);
  assert.equal((await call('PATCH', `/lines/${id}`, { account: '1' }, operator)).status, 403);
  assert.equal((await call('DELETE', `/lines/${id}`, undefined, operator)).status, 403);

  const clear = await call('PATCH', `/lines/${id}`, { assigneeName: '' }, operator);
  assert.equal(clear.data.line.assigneeName, null);
  await call('PATCH', `/lines/${id}`, { assigneeName: 'João' }, operator);

  const hist = await call('GET', `/lines/${id}/history`, undefined, operator);
  assert.equal(hist.data.history.length, 4);
  assert.equal(hist.data.history[0].changedBy, 'Operador');
});

test('importação CSV de linhas', async () => {
  const csv = 'Número;Operadora;Tipo;Usuário;Projeto;Data de entrega\n(11) 91111-1111;Claro;Dados;Ana;Obra B;10/02/2026\n(11) 98765-4321;Vivo;Dados e Voz;Dup;X;\nabc;Vivo;Dados;;;\n(21) 92222-2222;TIM;Dados e Voz;;Obra A;\n';
  const r = await call('POST', '/lines/import', { csv }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.created, 2);
  assert.equal(r.data.skipped, 1);
  assert.equal(r.data.errors.length, 1);
  const list = await call('GET', '/lines', undefined, admin);
  assert.equal(list.data.lines.length, 3);
});

test('consumo: prévia, gravação, duplicidade, resumo e histórico', async () => {
  const csv = 'Linha;Minutos;Dados (MB);Valor\n11987654321;100;2048;59,90\n11911111111;20;512;29,90\n11900000000;5;10;9,90\n';
  const payload = { filename: 'vivo_2026-05.csv', contentBase64: Buffer.from(csv).toString('base64') };

  const prev = await call('POST', '/consumption/parse', payload, admin);
  assert.equal(prev.status, 200, JSON.stringify(prev.data));
  assert.equal(prev.data.totals.lines, 3);
  assert.equal(prev.data.totals.registered, 2);
  assert.equal(prev.data.detectedCarrier, 'Vivo');
  assert.equal((await call('POST', '/consumption/parse', payload, operator)).status, 403);

  const save = await call('POST', '/consumption/invoices', { ...payload, carrier: 'Vivo', account: '0371235565', referenceMonth: '2026-05' }, admin);
  assert.equal(save.status, 201, JSON.stringify(save.data));
  assert.equal(save.data.lines, 3);
  assert.equal((await call('POST', '/consumption/invoices', { ...payload, carrier: 'Vivo', account: '0371235565', referenceMonth: '2026-05' }, admin)).status, 409);

  const csv2 = 'Linha;Minutos;Dados (MB);Valor\n11987654321;50;1024;59,90\n';
  const save2 = await call('POST', '/consumption/invoices', { filename: 'vivo_2026-06.csv', contentBase64: Buffer.from(csv2).toString('base64'), carrier: 'Vivo', account: '0371235565', referenceMonth: '2026-06' }, admin);
  assert.equal(save2.status, 201, JSON.stringify(save2.data));

  const sum = await call('GET', '/consumption/summary?from=2026-01&to=2026-12', undefined, admin);
  assert.equal(sum.status, 200, JSON.stringify(sum.data));
  assert.deepEqual(sum.data.months.map((m: any) => [m.month, m.voiceMinutes, m.dataMb]), [['2026-05', 125, 2570], ['2026-06', 50, 1024]]);
  const line = sum.data.lines.find((l: any) => l.number === '11987654321');
  assert.equal(line.voiceMinutes, 150);
  assert.equal(line.assigneeName, 'João');
  assert.equal(line.registered, true);
  assert.equal(sum.data.lines.find((l: any) => l.number === '11900000000').registered, false);

  const only = await call('GET', '/consumption/summary?from=2026-06&to=2026-06', undefined, admin);
  assert.equal(only.data.months.length, 1);
  const proj = await call('GET', '/consumption/summary?from=2026-01&to=2026-12&project=Obra%20A', undefined, admin);
  assert.equal(proj.data.lines.length, 1);

  const hist = await call('GET', '/consumption/lines/11987654321?from=2026-01&to=2026-12', undefined, admin);
  assert.equal(hist.data.months.length, 2);

  const invs = await call('GET', '/consumption/invoices', undefined, admin);
  assert.equal(invs.data.invoices.length, 2);
  assert.equal((await call('DELETE', `/consumption/invoices/${invs.data.invoices[0].id}`, undefined, admin)).status, 200);
  const after = await call('GET', '/consumption/summary?from=2026-01&to=2026-12', undefined, admin);
  assert.equal(after.data.months.length, 1);
});

test('admin não pode desativar a si mesmo; desativação derruba sessão', async () => {
  const me = (await call('GET', '/auth/me', undefined, admin)).data.user;
  assert.equal((await call('PATCH', `/users/${me.id}`, { active: false, confirmPassword: 'senha-super-segura' }, admin)).status, 400);
  const users = (await call('GET', '/users', undefined, admin)).data.users;
  const op = users.find((u: any) => u.email === 'op@x.com');
  assert.equal((await call('PATCH', `/users/${op.id}`, { active: false, confirmPassword: 'senha-super-segura' }, admin)).status, 200);
  assert.equal((await call('GET', '/lines', undefined, operator)).status, 401);
});
