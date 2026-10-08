import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { addUser, call, login, loadSchema, db } from './helpers.ts';
import { isSpare, SPARE } from '../src/assignee.ts';

const PW = 'senha-super-segura';
let admin = '';
let operator = '';
let n = 0;
const num = () => `(11) 9${String(80000000 + ++n).padStart(8, '0').replace(/^(\d{4})(\d{4})$/, '$1-$2')}`;
const createLine = (assigneeName?: unknown) =>
  call('POST', '/lines', { number: num(), carrier: 'Vivo', lineType: 'DADOS_VOZ', ...(assigneeName === undefined ? {} : { assigneeName }) }, admin);

before(async () => {
  await loadSchema();
  await addUser('adm@x.com', 'Adm', 'admin', PW);
  await addUser('op@x.com', 'Op', 'operator', PW);
  admin = await login('adm@x.com', PW);
  operator = await login('op@x.com', PW);
});

test('isSpare reconhece qualquer grafia de Spare e nada além disso', () => {
  for (const s of ['Spare', 'SPARE', 'spare', ' Spare ', 'sPaRe']) assert.equal(isSpare(s), true, s);
  for (const s of ['Bloqueada', 'Spare 2', 'Maria', '', null, undefined, 'Hydro - Spare']) assert.equal(isSpare(s as any), false, String(s));
  assert.equal(SPARE, 'Spare');
});

test('criar linha: usuário vazio, ausente ou qualquer grafia de spare vira "Spare"', async () => {
  for (const v of [undefined, '', '   ', null, 'spare', 'SPARE', '  Spare  ']) {
    const r = await createLine(v);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.line.assigneeName, 'Spare', `entrada: ${JSON.stringify(v)}`);
  }
  const maria = await createLine('Maria');
  assert.equal(maria.data.line.assigneeName, 'Maria');
  const hydro = await createLine('Linhas Hydro - Aguardando Usuários');
  assert.equal(hydro.data.line.assigneeName, 'Linhas Hydro - Aguardando Usuários'); // nomes de projeto não são tocados
});

test('editar linha: vazio vira Spare (admin e equipe); outros nomes continuam como digitados', async () => {
  const id = (await createLine('Maria')).data.line.id;
  const byOp = await call('PATCH', `/lines/${id}`, { assigneeName: '' }, operator);
  assert.equal(byOp.status, 200);
  assert.equal(byOp.data.line.assigneeName, 'Spare');
  assert.equal((await call('PATCH', `/lines/${id}`, { assigneeName: 'João' }, operator)).data.line.assigneeName, 'João');
  assert.equal((await call('PATCH', `/lines/${id}`, { assigneeName: 'sPaRe' }, admin)).data.line.assigneeName, 'Spare');
  assert.equal((await call('PATCH', `/lines/${id}`, { assigneeName: null }, admin)).data.line.assigneeName, 'Spare');
  // não mexe no usuário quando o campo nem foi enviado
  await call('PATCH', `/lines/${id}`, { assigneeName: 'Ana' }, admin);
  assert.equal((await call('PATCH', `/lines/${id}`, { deliveryDate: '2026-05-01' }, operator)).data.line.assigneeName, 'Ana');
});

test('importar CSV: usuário vazio e "SPARE"/"spare" viram "Spare"', async () => {
  const csv = [
    'Número;Operadora;Tipo;Usuário',
    '(21) 97000-0001;Vivo;Dados e Voz;',
    '(21) 97000-0002;Vivo;Dados e Voz;SPARE',
    '(21) 97000-0003;Vivo;Dados e Voz;spare',
    '(21) 97000-0004;Vivo;Dados e Voz;Carlos',
  ].join('\n');
  const r = await call('POST', '/lines/import', { csv }, admin);
  assert.equal(r.data.created, 4, JSON.stringify(r.data));
  const rows = (await db.query(`select number, assignee_name from lines where number like '2197000000%' order by number`)).rows as any[];
  assert.deepEqual(rows.map((x) => x.assignee_name), ['Spare', 'Spare', 'Spare', 'Carlos']);
});

test('nenhuma linha fica sem usuário depois dessas operações', async () => {
  const r = await db.query(`select count(*)::int n from lines where assignee_name is null or btrim(assignee_name) = ''`);
  assert.equal((r.rows[0] as any).n, 0);
});
