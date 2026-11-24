import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { addUser, call, db, loadSchema, login, quietErrors } from './helpers.ts';

const PW = 'senha-super-segura';
const GMAIL = 'conta.padrao@gmail.com';
const GPASS = 'S3nha-Do-G@il com espaço!';
let admin = '';
let team = '';
let n = 0;
const create = async () => (await call('POST', '/lines', { number: `(11) 95000-${String(2000 + ++n)}`, carrier: 'Vivo', lineType: 'DADOS_VOZ' }, admin)).data.line.id as string;

before(async () => {
  await loadSchema();
  await addUser('adm@x.com', 'Adm', 'admin', PW);
  await addUser('ti@x.com', 'TI', 'operator', PW);
  admin = await login('adm@x.com', PW);
  team = await login('ti@x.com', PW);
});

test('salvar e consultar: admin e equipe veem, mas só com a própria senha; listagem nunca traz os dados', async () => {
  const id = await create();
  assert.equal((await call('PUT', `/lines/${id}/device-account`, { email: GMAIL, password: GPASS }, admin)).status, 200);

  const list = (await call('GET', '/lines', undefined, team)).data.lines.find((l: any) => l.id === id);
  assert.equal(list.hasDeviceAccount, true);
  const raw = JSON.stringify((await call('GET', '/lines', undefined, admin)).data);
  assert.ok(!raw.includes(GMAIL) && !raw.includes('S3nha-Do'), 'a listagem não pode conter e-mail nem senha');

  // sem a senha de confirmação, ou com senha errada: nada é revelado
  assert.equal((await call('POST', `/lines/${id}/device-account/reveal`, {}, team)).status, 403);
  const wrong = await call('POST', `/lines/${id}/device-account/reveal`, { confirmPassword: 'errada-errada-1' }, team);
  assert.equal(wrong.status, 403);
  assert.ok(!JSON.stringify(wrong.data).includes('gmail'));

  for (const cookie of [team, admin]) {
    const ok = await call('POST', `/lines/${id}/device-account/reveal`, { confirmPassword: PW }, cookie);
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.deepEqual(ok.data, { email: GMAIL, password: GPASS });
  }
  assert.equal((await call('GET', '/lines', undefined, admin)).data.lines.find((l: any) => l.id === id).device, null);
});

test('no banco só existe texto cifrado, preso à linha (não abre em outra)', async () => {
  const a = await create();
  const b = await create();
  await call('PUT', `/lines/${a}/device-account`, { email: GMAIL, password: GPASS }, admin);
  const [row] = (await db.query(`select device_account_enc from lines where id = $1`, [a])).rows as any[];
  assert.match(row.device_account_enc, /^v1:/);
  assert.ok(!row.device_account_enc.includes('gmail') && !row.device_account_enc.includes('S3nha'));
  // dois cadastros iguais geram textos cifrados diferentes (IV aleatório)
  await call('PUT', `/lines/${a}/device-account`, { email: GMAIL, password: GPASS }, admin);
  const [row2] = (await db.query(`select device_account_enc from lines where id = $1`, [a])).rows as any[];
  assert.notEqual(row.device_account_enc, row2.device_account_enc);
  // copiar o texto cifrado para outra linha não permite abrir
  await db.query(`update lines set device_account_enc = $1 where id = $2`, [row2.device_account_enc, b]);
  const restore = quietErrors();
  const moved = await call('POST', `/lines/${b}/device-account/reveal`, { confirmPassword: PW }, admin);
  restore();
  assert.equal(moved.status, 409);
  // adulterado também falha
  await db.query(`update lines set device_account_enc = $1 where id = $2`, [row2.device_account_enc.slice(0, -4) + 'AAAA', a]);
  assert.equal((await call('POST', `/lines/${a}/device-account/reveal`, { confirmPassword: PW }, admin)).status, 409);
});

test('auditoria registra quem viu/alterou, sem e-mail nem senha', async () => {
  const id = await create();
  await call('PUT', `/lines/${id}/device-account`, { email: 'segredo.auditoria@gmail.com', password: 'SEGREDO-AUDITORIA-9' }, team);
  await call('POST', `/lines/${id}/device-account/reveal`, { confirmPassword: PW }, team);
  const audit = JSON.stringify((await db.query(`select action, actor_email, target, detail from audit_log`)).rows);
  assert.ok(audit.includes('device_account_saved') && audit.includes('device_account_revealed') && audit.includes('ti@x.com'));
  assert.ok(!audit.includes('SEGREDO-AUDITORIA') && !audit.includes('segredo.auditoria'));
  const hist = JSON.stringify((await db.query(`select * from line_history`)).rows);
  assert.ok(!hist.includes('SEGREDO-AUDITORIA') && !hist.includes('segredo.auditoria'));
});

test('equipe cadastra, mas só o administrador remove', async () => {
  const id = await create();
  assert.equal((await call('PUT', `/lines/${id}/device-account`, { email: GMAIL, password: GPASS }, team)).status, 200);
  assert.equal((await call('DELETE', `/lines/${id}/device-account`, undefined, team)).status, 403);
  assert.equal((await call('GET', '/lines', undefined, team)).data.lines.find((l: any) => l.id === id).hasDeviceAccount, true);
  assert.equal((await call('DELETE', `/lines/${id}/device-account`, undefined, admin)).status, 200);
  assert.equal((await call('GET', '/lines', undefined, team)).data.lines.find((l: any) => l.id === id).hasDeviceAccount, false);
  assert.equal((await call('POST', `/lines/${id}/device-account/reveal`, { confirmPassword: PW }, admin)).status, 404);
});

test('sem sessão não acessa; validações de e-mail e senha', async () => {
  const id = await create();
  assert.equal((await call('PUT', `/lines/${id}/device-account`, { email: GMAIL, password: GPASS })).status, 401);
  assert.equal((await call('POST', `/lines/${id}/device-account/reveal`, { confirmPassword: PW })).status, 401);
  assert.equal((await call('PUT', `/lines/${id}/device-account`, { email: 'nao-e-email', password: GPASS }, admin)).status, 400);
  assert.equal((await call('PUT', `/lines/${id}/device-account`, { email: GMAIL, password: '' }, admin)).status, 400);
  assert.equal((await call('PUT', `/lines/${id}/device-account`, { email: GMAIL, password: 'x'.repeat(201) }, admin)).status, 400);
  assert.equal((await call('PUT', `/lines/${id}/device-account`, { email: GMAIL, password: 'a\nb' }, admin)).status, 400);
  assert.equal((await call('PUT', `/lines/${id}/device-account`, { email: GMAIL, password: 123 }, admin)).status, 400);
  assert.equal((await call('PUT', `/lines/00000000-0000-0000-0000-000000000000/device-account`, { email: GMAIL, password: GPASS }, admin)).status, 404);
  assert.equal((await call('PUT', `/lines/não-uuid/device-account`, { email: GMAIL, password: GPASS }, admin)).status, 400);
});

test('editar a linha não mexe nas credenciais; trocar o usuário também não as apaga; excluir a linha remove', async () => {
  const id = await create();
  await call('PUT', `/lines/${id}/device-account`, { email: GMAIL, password: GPASS }, admin);
  await call('PATCH', `/lines/${id}`, { assigneeName: 'Nova Pessoa', notes: 'x' }, admin);
  const r = await call('POST', `/lines/${id}/device-account/reveal`, { confirmPassword: PW }, admin);
  assert.equal(r.data.password, GPASS);
  // o campo não pode ser alterado pelo PATCH da linha
  assert.equal((await call('PATCH', `/lines/${id}`, { deviceAccountEnc: 'x' }, admin)).status, 400);
  assert.equal((await call('DELETE', `/lines/${id}`, undefined, admin)).status, 200);
});

test('sem a chave de criptografia configurada o cofre recusa (não grava em texto puro)', async () => {
  const id = await create();
  const saved = process.env.FIELD_ENCRYPTION_KEY;
  try {
    delete process.env.FIELD_ENCRYPTION_KEY;
    const r = await call('PUT', `/lines/${id}/device-account`, { email: GMAIL, password: GPASS }, admin);
    assert.equal(r.status, 503);
    process.env.FIELD_ENCRYPTION_KEY = 'curta';
    assert.equal((await call('PUT', `/lines/${id}/device-account`, { email: GMAIL, password: GPASS }, admin)).status, 503);
    const [row] = (await db.query(`select device_account_enc from lines where id = $1`, [id])).rows as any[];
    assert.equal(row.device_account_enc, null);
  } finally {
    process.env.FIELD_ENCRYPTION_KEY = saved;
  }
});

test('trocar a chave impede abrir credenciais antigas (aviso claro, sem vazar nada)', async () => {
  const id = await create();
  await call('PUT', `/lines/${id}/device-account`, { email: GMAIL, password: GPASS }, admin);
  const saved = process.env.FIELD_ENCRYPTION_KEY;
  try {
    process.env.FIELD_ENCRYPTION_KEY = 'outra-chave-'.repeat(4);
    const restore = quietErrors();
    const r = await call('POST', `/lines/${id}/device-account/reveal`, { confirmPassword: PW }, admin);
    restore();
    assert.equal(r.status, 409);
    assert.ok(!JSON.stringify(r.data).includes('gmail'));
  } finally {
    process.env.FIELD_ENCRYPTION_KEY = saved;
  }
});
