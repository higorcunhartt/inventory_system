import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { addUser, call, login, loadSchema, db } from './helpers.ts';
import { hasActiveFilters } from '../src/filters.ts';

const PW = 'senha-super-segura';
let admin = '';
let operator = '';
let n = 0;
const num = () => `(11) 96000-${String(1000 + ++n)}`;
const create = (extra: Record<string, unknown> = {}) => call('POST', '/lines', { number: num(), carrier: 'Vivo', lineType: 'DADOS_VOZ', ...extra }, admin);

before(async () => {
  await loadSchema();
  await addUser('adm@x.com', 'Adm', 'admin', PW);
  await addUser('op@x.com', 'Op', 'operator', PW);
  admin = await login('adm@x.com', PW);
  operator = await login('op@x.com', PW);
});

test('criar linha com dispositivo: grava, normaliza espaços e vazio vira nulo', async () => {
  const r = await create({ assigneeName: 'Maria', device: '  Samsung   Galaxy  A54 ' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.line.device, 'Samsung Galaxy A54');
  assert.equal((await create({ device: '' })).data.line.device, null);
  assert.equal((await create({ device: '   ' })).data.line.device, null);
  assert.equal((await create()).data.line.device, null);
  const listed = (await call('GET', '/lines', undefined, operator)).data.lines.find((l: any) => l.id === r.data.line.id);
  assert.equal(listed.device, 'Samsung Galaxy A54');
});

test('validação do dispositivo: tamanho e caracteres de controle', async () => {
  assert.equal((await create({ device: 'x'.repeat(81) })).status, 400);
  assert.equal((await create({ device: 'linha1\nlinha2' })).status, 400);
  assert.equal((await create({ device: 'a\tb' })).status, 400);
  assert.equal((await create({ device: 'x'.repeat(80) })).status, 201);
  assert.equal((await create({ device: 123 })).status, 400); // não é texto
  // texto "perigoso" é só dado: é guardado como veio (a tela escapa), nunca interpretado
  const html = await create({ device: '<img src=x onerror=alert(1)>' });
  assert.equal(html.status, 201);
  assert.equal(html.data.line.device, '<img src=x onerror=alert(1)>');
});

test('editar: só o administrador altera o dispositivo; vazio limpa', async () => {
  const id = (await create({ assigneeName: 'Ana', device: 'iPhone 13' })).data.line.id;
  const up = await call('PATCH', `/lines/${id}`, { device: 'iPhone 15' }, admin);
  assert.equal(up.data.line.device, 'iPhone 15');
  assert.equal(up.data.line.assigneeName, 'Ana');
  assert.equal((await call('PATCH', `/lines/${id}`, { device: 'Moto G' }, operator)).status, 403);
  assert.equal((await call('PATCH', `/lines/${id}`, { device: '' }, admin)).data.line.device, null);
  assert.equal((await call('PATCH', `/lines/${id}`, { device: 'a\nb' }, admin)).status, 400);
});

test('trocar o usuário limpa o dispositivo, a menos que o administrador informe o novo', async () => {
  const mk = async () => (await create({ assigneeName: 'Carlos', device: 'Galaxy S21' })).data.line.id;
  const a = await mk();
  assert.equal((await call('PATCH', `/lines/${a}`, { assigneeName: 'Diego' }, operator)).data.line.device, null);
  const b = await mk();
  assert.equal((await call('PATCH', `/lines/${b}`, { deliveryDate: '2026-06-01' }, operator)).data.line.device, 'Galaxy S21'); // só a data
  assert.equal((await call('PATCH', `/lines/${b}`, { assigneeName: 'Carlos' }, operator)).data.line.device, 'Galaxy S21'); // mesmo usuário
  const c = await mk();
  assert.equal((await call('PATCH', `/lines/${c}`, { assigneeName: '' }, operator)).data.line.device, null); // liberar = Spare
  const d = await mk();
  assert.equal((await call('PATCH', `/lines/${d}`, { assigneeName: 'Eva' }, admin)).data.line.device, null);
  const e = await mk();
  assert.equal((await call('PATCH', `/lines/${e}`, { assigneeName: 'Eva', device: 'Pixel 8' }, admin)).data.line.device, 'Pixel 8');
});

test('importar CSV reconhece Dispositivo (ou Aparelho) e reporta inválidos', async () => {
  const csv = [
    'Número;Operadora;Tipo;Usuário;Dispositivo',
    '(21) 95000-0001;Vivo;Dados e Voz;Fábio;iPhone 12',
    '(21) 95000-0002;Vivo;Dados e Voz;Gil;',
    '(21) 95000-0003;Vivo;Dados e Voz;Hugo;linha\u0007com controle',
  ].join('\n');
  const r = await call('POST', '/lines/import', { csv }, admin);
  assert.equal(r.data.created, 2, JSON.stringify(r.data));
  assert.deepEqual(r.data.errors.map((e: any) => e.row), [4]);
  const csv2 = 'Número;Operadora;Tipo;Aparelho\n(21) 95000-0010;Vivo;Dados;Moto E22\n';
  assert.equal((await call('POST', '/lines/import', { csv: csv2 }, admin)).data.created, 1);
  const rows = (await db.query(`select number, device from lines where number in ('21950000001','21950000002','21950000010') order by number`)).rows as any[];
  assert.deepEqual(rows.map((x) => x.device), ['iPhone 12', null, 'Moto E22']);
});

test('o conteúdo do dispositivo não vai para a Auditoria (só o nome do campo)', async () => {
  const id = (await create({ assigneeName: 'Juca', device: 'SEGREDO-APARELHO-1' })).data.line.id;
  await call('PATCH', `/lines/${id}`, { device: 'SEGREDO-APARELHO-2' }, admin);
  const audit = JSON.stringify((await db.query(`select action, target, detail from audit_log`)).rows);
  assert.ok(!audit.includes('SEGREDO-APARELHO'));
  assert.ok(audit.includes('"device"'));
});

test('botão "Limpar filtros": só habilita quando há busca ou filtro aplicado', () => {
  const base = { q: '', carrier: '', project: '', type: '', onlySpare: false };
  assert.equal(hasActiveFilters(base), false);
  assert.equal(hasActiveFilters({ ...base, q: '   ' }), false); // só espaços não conta
  for (const on of [{ q: 'maria' }, { carrier: 'Vivo' }, { project: 'Obra A' }, { type: 'DADOS' }, { onlySpare: true }]) {
    assert.equal(hasActiveFilters({ ...base, ...on }), true, JSON.stringify(on));
  }
});
