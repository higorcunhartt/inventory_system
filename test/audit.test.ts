import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { addUser, call, login, loadSchema, db } from './helpers.ts';

let admin = '';
let operator = '';
const PW = 'senha-super-segura';

before(async () => {
  await loadSchema();
  await addUser('adm@x.com', 'Adm', 'admin', PW);
  await addUser('op@x.com', 'Op', 'operator', PW);
  admin = await login('adm@x.com', PW);
  operator = await login('op@x.com', PW);
});

const events = async (action?: string) =>
  (await db.query(`select * from audit_log ${action ? `where action = '${action}'` : ''} order by id`)).rows as any[];

test('AUD-005: falhas, bloqueios e sucessos de login são registrados', async () => {
  for (let i = 0; i < 7; i++) await call('POST', '/auth/login', { email: 'op@x.com', password: 'errada-errada-1' }, undefined, { 'x-forwarded-for': '9.9.9.9' });
  assert.equal((await events('login_failed')).length, 5);
  assert.ok((await events('login_blocked')).length >= 2);
  assert.ok((await events('login_success')).length >= 2); // admin e operador do before()
  const failed = (await events('login_failed'))[0];
  assert.equal(failed.ip, '9.9.9.9');
  assert.equal(failed.result, 'fail');
});

test('AUD-005: ações administrativas são registradas e nada sensível entra no log', async () => {
  const created = await call('POST', '/users', { name: 'Novo', email: 'novo@x.com', role: 'operator', password: 'frase-temporaria-forte-1', confirmPassword: PW }, admin);
  assert.equal(created.status, 201);
  await call('PATCH', `/users/${created.data.user.id}`, { role: 'admin', confirmPassword: PW }, admin);
  await call('POST', '/users', { name: 'X', email: 'x1@x.com', password: 'frase-temporaria-forte-1', confirmPassword: 'errada-errada-1' }, admin);
  assert.equal((await events('user_created')).length, 1);
  assert.equal((await events('user_updated')).length, 1);
  assert.equal((await events('reauth_failed')).length, 1);
  const all = JSON.stringify(await events());
  for (const secret of [PW, 'frase-temporaria-forte-1', 'errada-errada-1', 'mfaToken']) assert.ok(!all.includes(secret), `vazou: ${secret}`);
});

test('AUD-005: a trilha sobrevive à exclusão da linha (o histórico da linha não)', async () => {
  const line = await call('POST', '/lines', { number: '(11) 98888-7777', carrier: 'Vivo', lineType: 'DADOS_VOZ', assigneeName: 'Maria' }, admin);
  const id = line.data.line.id;
  await call('PATCH', `/lines/${id}`, { assigneeName: 'João' }, operator);
  await call('DELETE', `/lines/${id}`, undefined, admin);
  const hist = await db.query(`select count(*)::int n from line_history where line_id = $1`, [id]);
  assert.equal((hist.rows[0] as any).n, 0);
  const del = (await events('line_deleted'))[0];
  assert.equal(del.target, '11988887777');
  assert.equal(del.detail.assignee, 'João');
  assert.equal((await events('line_updated'))[0].actor_email, 'op@x.com');
});

test('AUD-005: faturas salvas/removidas são registradas; GET /audit é só do administrador', async () => {
  const csv = 'Linha;Minutos;Dados (MB);Valor\n11987654321;10;100;10,00\n';
  const saved = await call('POST', '/consumption/invoices', { filename: 'f.csv', contentBase64: Buffer.from(csv).toString('base64'), carrier: 'Vivo', referenceMonth: '2026-05' }, admin);
  assert.equal(saved.status, 201);
  await call('DELETE', `/consumption/invoices/${saved.data.id}`, undefined, admin);
  assert.equal((await events('invoice_saved')).length, 1);
  assert.equal((await events('invoice_deleted')).length, 1);
  assert.equal((await call('GET', '/audit', undefined, operator)).status, 403);
  const list = await call('GET', '/audit?limit=5', undefined, admin);
  assert.equal(list.status, 200);
  assert.equal(list.data.events.length, 5);
  const filtered = await call('GET', '/audit?action=line_deleted', undefined, admin);
  assert.ok(filtered.data.events.every((e: any) => e.action === 'line_deleted'));
});
