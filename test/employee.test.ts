import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { addUser, call, login, loadSchema, db } from './helpers.ts';

const PW = 'senha-super-segura';
let admin = '';
let operator = '';
let n = 0;
const num = () => `(11) 97000-${String(1000 + ++n)}`;
const create = (extra: Record<string, unknown> = {}) => call('POST', '/lines', { number: num(), carrier: 'Vivo', lineType: 'DADOS_VOZ', ...extra }, admin);

before(async () => {
  await loadSchema();
  await addUser('adm@x.com', 'Adm', 'admin', PW);
  await addUser('op@x.com', 'Op', 'operator', PW);
  admin = await login('adm@x.com', PW);
  operator = await login('op@x.com', PW);
});

test('criar linha com matrícula e e-mail: ficam gravados, e-mail em minúsculas; vazio vira nulo', async () => {
  const r = await create({ assigneeName: 'Maria', employeeId: 'RTT-00123', assigneeEmail: '  Maria.Souza@RTTShop.com.br ' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.line.employeeId, 'RTT-00123');
  assert.equal(r.data.line.assigneeEmail, 'maria.souza@rttshop.com.br');
  const empty = await create({ employeeId: '', assigneeEmail: '   ' });
  assert.equal(empty.data.line.employeeId, null);
  assert.equal(empty.data.line.assigneeEmail, null);
  const none = await create();
  assert.equal(none.data.line.employeeId, null);
  const listed = (await call('GET', '/lines', undefined, operator)).data.lines.find((l: any) => l.id === r.data.line.id);
  assert.equal(listed.employeeId, 'RTT-00123');
  assert.equal(listed.assigneeEmail, 'maria.souza@rttshop.com.br');
});

test('validação: e-mail e matrícula inválidos são recusados com 400', async () => {
  for (const bad of ['sem-arroba', 'a@b', 'a b@c.com', '@x.com', 'x'.repeat(250) + '@a.com']) {
    assert.equal((await create({ assigneeEmail: bad })).status, 400, `e-mail: ${bad.slice(0, 30)}`);
  }
  for (const bad of ['12 34', '../etc', "1'; drop table lines;--", 'a'.repeat(31), '-123', '12\n34', '<b>1</b>']) {
    assert.equal((await create({ employeeId: bad })).status, 400, `matrícula: ${bad.slice(0, 30)}`);
  }
  for (const ok of ['0012345', 'A-1', 'rtt/2026.10', 'ab_c']) {
    assert.equal((await create({ employeeId: ok })).status, 201, `matrícula: ${ok}`);
  }
});

test('editar: admin altera e limpa; equipe não pode tocar nesses campos', async () => {
  const id = (await create({ assigneeName: 'Ana', employeeId: '111', assigneeEmail: 'ana@x.com' })).data.line.id;
  const up = await call('PATCH', `/lines/${id}`, { employeeId: '222', assigneeEmail: 'ANA.NOVA@x.com' }, admin);
  assert.equal(up.status, 200);
  assert.equal(up.data.line.employeeId, '222');
  assert.equal(up.data.line.assigneeEmail, 'ana.nova@x.com');
  assert.equal(up.data.line.assigneeName, 'Ana'); // o resto não muda
  const cleared = await call('PATCH', `/lines/${id}`, { employeeId: '', assigneeEmail: '' }, admin);
  assert.equal(cleared.data.line.employeeId, null);
  assert.equal(cleared.data.line.assigneeEmail, null);
  assert.equal((await call('PATCH', `/lines/${id}`, { employeeId: '999' }, operator)).status, 403);
  assert.equal((await call('PATCH', `/lines/${id}`, { assigneeEmail: 'x@y.com' }, operator)).status, 403);
  assert.equal((await call('PATCH', `/lines/${id}`, { employeeId: 'valor inválido!' }, admin)).status, 400);
});

test('trocar o usuário limpa matrícula e e-mail da pessoa anterior (equipe e admin sem informar novos)', async () => {
  const mk = async () => (await create({ assigneeName: 'Carlos', employeeId: '300', assigneeEmail: 'carlos@x.com' })).data.line.id;
  // equipe troca o usuário
  const a = await mk();
  const byOp = await call('PATCH', `/lines/${a}`, { assigneeName: 'Diego' }, operator);
  assert.equal(byOp.data.line.assigneeName, 'Diego');
  assert.equal(byOp.data.line.employeeId, null);
  assert.equal(byOp.data.line.assigneeEmail, null);
  // equipe só muda a data (ou "troca" para o mesmo usuário): nada é limpo
  const b = await mk();
  assert.equal((await call('PATCH', `/lines/${b}`, { deliveryDate: '2026-06-01' }, operator)).data.line.employeeId, '300');
  assert.equal((await call('PATCH', `/lines/${b}`, { assigneeName: 'Carlos' }, operator)).data.line.assigneeEmail, 'carlos@x.com');
  // liberar a linha (vazio = Spare) também limpa
  const c = await mk();
  const spare = await call('PATCH', `/lines/${c}`, { assigneeName: '' }, operator);
  assert.deepEqual([spare.data.line.assigneeName, spare.data.line.employeeId, spare.data.line.assigneeEmail], ['Spare', null, null]);
  // admin troca o usuário sem enviar matrícula/e-mail → limpa; enviando os novos → ficam os novos
  const d = await mk();
  assert.equal((await call('PATCH', `/lines/${d}`, { assigneeName: 'Eva' }, admin)).data.line.employeeId, null);
  const e = await mk();
  const withNew = await call('PATCH', `/lines/${e}`, { assigneeName: 'Eva', employeeId: '400', assigneeEmail: 'eva@x.com' }, admin);
  assert.deepEqual([withNew.data.line.employeeId, withNew.data.line.assigneeEmail], ['400', 'eva@x.com']);
});

test('importar CSV reconhece as colunas Matrícula e E-mail e reporta linhas inválidas', async () => {
  const csv = [
    'Número;Operadora;Tipo;Usuário;Matrícula;E-mail',
    '(21) 96000-0001;Vivo;Dados e Voz;Fábio;M-1;FABIO@x.com',
    '(21) 96000-0002;Vivo;Dados e Voz;Gil;;',
    '(21) 96000-0003;Vivo;Dados e Voz;Hugo;M 3;hugo@x.com',
    '(21) 96000-0004;Vivo;Dados e Voz;Iara;M-4;iara-sem-arroba',
  ].join('\n');
  const r = await call('POST', '/lines/import', { csv }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.created, 2);
  assert.deepEqual(r.data.errors.map((e: any) => e.row), [4, 5]);
  const rows = (await db.query(`select number, employee_id, assignee_email from lines where number like '2196000000%' order by number`)).rows as any[];
  assert.deepEqual(rows.map((x) => [x.employee_id, x.assignee_email]), [['M-1', 'fabio@x.com'], [null, null]]);
});

test('dados pessoais não vão para a Auditoria nem para o histórico da linha (só o nome do campo)', async () => {
  const id = (await create({ assigneeName: 'Juca', employeeId: 'SEGREDO-777', assigneeEmail: 'juca.sigiloso@x.com' })).data.line.id;
  await call('PATCH', `/lines/${id}`, { employeeId: 'SEGREDO-888', assigneeEmail: 'outro.sigiloso@x.com' }, admin);
  const audit = JSON.stringify((await db.query(`select action, target, detail from audit_log`)).rows);
  const hist = JSON.stringify((await db.query(`select * from line_history`)).rows);
  for (const secret of ['SEGREDO-777', 'SEGREDO-888', 'juca.sigiloso@x.com', 'outro.sigiloso@x.com']) {
    assert.ok(!audit.includes(secret), `vazou na auditoria: ${secret}`);
    assert.ok(!hist.includes(secret), `vazou no histórico: ${secret}`);
  }
  assert.ok(audit.includes('employeeId')); // registra QUE o campo mudou
});
