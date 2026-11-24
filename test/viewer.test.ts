import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { addUser, call, loadSchema, login } from './helpers.ts';

const PW = 'senha-super-segura';
let admin = '';
let viewer = '';
let id = '';

before(async () => {
  await loadSchema();
  await addUser('adm@x.com', 'Adm', 'admin', PW);
  await addUser('apr@x.com', 'Aprendiz', 'viewer', PW);
  admin = await login('adm@x.com', PW);
  viewer = await login('apr@x.com', PW);
  id = (await call('POST', '/lines', { number: '(11) 95000-7001', carrier: 'Vivo', lineType: 'DADOS_VOZ' }, admin)).data.line.id;
  await call('PUT', `/lines/${id}/device-account`, { email: 'conta@gmail.com', password: 'S3nha-secreta' }, admin);
});

test('consulta lê linhas e histórico', async () => {
  const list = await call('GET', '/lines', undefined, viewer);
  assert.equal(list.status, 200);
  assert.ok(list.data.lines.length >= 1);
  assert.equal((await call('GET', `/lines/${id}/history`, undefined, viewer)).status, 200);
  assert.equal((await call('GET', '/auth/me', undefined, viewer)).data.user.role, 'viewer');
});

test('consulta não altera, não cria, não exclui nem importa', async () => {
  assert.equal((await call('PATCH', `/lines/${id}`, { assigneeName: 'João' }, viewer)).status, 403);
  assert.equal((await call('PATCH', `/lines/${id}`, { deliveryDate: '2026-03-01' }, viewer)).status, 403);
  assert.equal((await call('POST', '/lines', { number: '(11) 95000-7002', carrier: 'Vivo', lineType: 'DADOS' }, viewer)).status, 403);
  assert.equal((await call('POST', '/lines/import', { csv: 'x' }, viewer)).status, 403);
  assert.equal((await call('DELETE', `/lines/${id}`, undefined, viewer)).status, 403);
});

test('consulta não acessa conta do aparelho, usuários, auditoria nem consumo', async () => {
  assert.equal((await call('POST', `/lines/${id}/device-account/reveal`, { confirmPassword: PW }, viewer)).status, 403);
  assert.equal((await call('PUT', `/lines/${id}/device-account`, { email: 'a@b.com', password: 'x' }, viewer)).status, 403);
  assert.equal((await call('DELETE', `/lines/${id}/device-account`, undefined, viewer)).status, 403);
  assert.equal((await call('GET', '/users', undefined, viewer)).status, 403);
  assert.equal((await call('GET', '/audit', undefined, viewer)).status, 403);
  assert.equal((await call('GET', '/consumption/summary', undefined, viewer)).status, 403);
  const raw = JSON.stringify((await call('GET', '/lines', undefined, viewer)).data);
  assert.ok(!raw.includes('conta@gmail.com') && !raw.includes('S3nha-secreta'));
});

test('admin cria e troca perfil para consulta', async () => {
  const c = await call('POST', '/users', { name: 'Novo Aprendiz', email: 'novo.apr@x.com', role: 'viewer', confirmPassword: PW }, admin);
  assert.equal(c.status, 201, JSON.stringify(c.data));
  assert.equal(c.data.user.role, 'viewer');
  assert.equal((await call('POST', '/users', { name: 'X', email: 'x2@x.com', role: 'qualquer', confirmPassword: PW }, admin)).status, 400);
});
