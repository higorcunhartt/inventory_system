import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { addUser, call, login, loadSchema, db, lastLink, linkCount, tokenOf } from './helpers.ts';

const PW = 'senha-super-segura';
let admin = '';

const hoursOfLastToken = async () =>
  Number(((await db.query(`select extract(epoch from (expires_at - created_at)) / 3600 as h from password_tokens order by created_at desc, id desc limit 1`)).rows[0] as any).h);
const create = (email: string, name = 'Novo') => call('POST', '/users', { name, email, role: 'operator', confirmPassword: PW }, admin);

before(async () => {
  await loadSchema();
  await addUser('adm@x.com', 'Adm', 'admin', PW);
  admin = await login('adm@x.com', PW);
});

test('convite: usuário nasce sem senha, recebe link de 24 h e o token só existe em hash no banco', async () => {
  const before = linkCount;
  const r = await create('conv1@x.com');
  assert.equal(r.status, 201);
  assert.equal(r.data.emailSent, true);
  assert.equal(linkCount, before + 1);
  assert.match(lastLink, /\/definir-senha#t=[A-Za-z0-9_-]{43}$/); // token no fragmento, 256 bits, sem query string
  assert.ok(!lastLink.includes('?'));
  assert.ok(Math.abs((await hoursOfLastToken()) - 24) < 0.01);
  const rows = (await db.query(`select token_hash from password_tokens`)).rows as any[];
  const token = tokenOf(lastLink);
  assert.ok(rows.every((x) => x.token_hash !== token && /^[0-9a-f]{64}$/.test(x.token_hash)));
  // ninguém (nem o admin) conhece a senha: não dá para entrar antes de definir pelo link
  for (const guess of [PW, 'senha-temporaria1', 'Mudar@12345', '']) {
    const l = await call('POST', '/auth/login', { email: 'conv1@x.com', password: guess || 'x' }, undefined, { 'x-forwarded-for': '10.20.0.1' });
    assert.ok([401, 429].includes(l.status));
  }
  const listed = (await call('GET', '/users', undefined, admin)).data.users.find((u: any) => u.email === 'conv1@x.com');
  assert.equal(listed.mustChangePassword, true);
  assert.equal(listed.pendingLink, true);
});

test('convite: política de senha não gasta o link; uso único; login exige MFA depois', async () => {
  await create('conv2@x.com');
  const token = tokenOf(lastLink);
  assert.equal((await call('POST', '/auth/set-password', { token, newPassword: 'password123' })).status, 400); // senha comum: link preservado
  assert.equal((await call('POST', '/auth/set-password', { token, newPassword: 'curta' })).status, 400);
  const ok = await call('POST', '/auth/set-password', { token, newPassword: 'frase-longa-do-convite-1' });
  assert.equal(ok.status, 200);
  assert.equal(ok.setCookie, null); // não inicia sessão sozinho
  const reuse = await call('POST', '/auth/set-password', { token, newPassword: 'outra-frase-longa-do-convite-2' });
  assert.equal(reuse.status, 400);
  assert.match(reuse.data.error, /inválido|expirado|usado/i);
  const cookie = await login('conv2@x.com', 'frase-longa-do-convite-1', { 'x-forwarded-for': '10.20.0.2' }); // senha + código por e-mail
  assert.equal((await call('GET', '/auth/me', undefined, cookie)).data.user.mustChangePassword, false);
  const listed = (await call('GET', '/users', undefined, admin)).data.users.find((u: any) => u.email === 'conv2@x.com');
  assert.equal(listed.pendingLink, false);
});

test('convite: link expirado e token inventado são recusados com a mesma mensagem', async () => {
  await create('conv3@x.com');
  const token = tokenOf(lastLink);
  await db.query(`update password_tokens set expires_at = now() - interval '1 minute' where token_hash is not null and used_at is null and user_id = (select id from users where email = 'conv3@x.com')`);
  const expired = await call('POST', '/auth/set-password', { token, newPassword: 'frase-longa-expirada-1' });
  const fake = await call('POST', '/auth/set-password', { token: 'A'.repeat(43), newPassword: 'frase-longa-expirada-1' });
  assert.equal(expired.status, 400);
  assert.equal(fake.status, 400);
  assert.equal(expired.data.error, fake.data.error);
});

test('reenvio: novo link invalida o anterior; exige confirmação; usuário inativo não recebe', async () => {
  await create('conv4@x.com');
  const first = tokenOf(lastLink);
  const id = ((await db.query(`select id from users where email = 'conv4@x.com'`)).rows[0] as any).id;
  assert.equal((await call('POST', `/users/${id}/invite`, {}, admin)).status, 403);
  assert.equal((await call('POST', `/users/${id}/invite`, { confirmPassword: 'errada-errada-1' }, admin)).status, 403);
  assert.equal((await call('POST', `/users/${id}/invite`, { confirmPassword: PW }, admin)).status, 200);
  const second = tokenOf(lastLink);
  assert.notEqual(first, second);
  assert.equal((await call('POST', '/auth/set-password', { token: first, newPassword: 'frase-longa-reenvio-1' })).status, 400);
  // desativar revoga links pendentes
  assert.equal((await call('PATCH', `/users/${id}`, { active: false, confirmPassword: PW }, admin)).status, 200);
  assert.equal((await call('POST', '/auth/set-password', { token: second, newPassword: 'frase-longa-reenvio-1' })).status, 400);
  assert.equal((await call('POST', `/users/${id}/invite`, { confirmPassword: PW }, admin)).status, 409);
});

test('o administrador não define senhas: PATCH com password e POST com password são recusados', async () => {
  await create('conv5@x.com');
  const id = ((await db.query(`select id from users where email = 'conv5@x.com'`)).rows[0] as any).id;
  assert.equal((await call('PATCH', `/users/${id}`, { password: 'frase-longa-do-admin-1', confirmPassword: PW }, admin)).status, 400);
  assert.equal((await call('POST', '/users', { name: 'X', email: 'conv5b@x.com', password: 'frase-longa-do-admin-1', confirmPassword: PW }, admin)).status, 400);
});

test('definir a senha revoga sessões antigas e os demais links do usuário', async () => {
  const uid = await addUser('sess@x.com', 'Sess', 'operator', PW);
  const old = await login('sess@x.com', PW, { 'x-forwarded-for': '10.20.0.3' });
  assert.equal((await call('POST', `/users/${uid}/invite`, { confirmPassword: PW }, admin)).status, 200);
  assert.equal((await call('GET', '/auth/me', undefined, old)).status, 200); // só enviar o link não derruba a sessão
  assert.equal((await call('POST', '/auth/set-password', { token: tokenOf(lastLink), newPassword: 'frase-longa-nova-sessao-1' })).status, 200);
  assert.equal((await call('GET', '/auth/me', undefined, old)).status, 401);
  assert.equal((await db.query(`select count(*)::int n from password_tokens where user_id = $1 and used_at is null`, [uid])).rows[0] && ((await db.query(`select count(*)::int n from password_tokens where user_id = $1 and used_at is null`, [uid])).rows[0] as any).n, 0);
});

test('esqueci minha senha: resposta idêntica para e-mail existente e inexistente; link de 1 h', async () => {
  await addUser('esq@x.com', 'Esq', 'operator', PW);
  const known = await call('POST', '/auth/forgot', { email: 'esq@x.com' }, undefined, { 'x-forwarded-for': '10.30.0.1' });
  assert.equal(known.status, 200);
  assert.match(lastLink, /\/definir-senha#t=/);
  assert.ok(Math.abs((await hoursOfLastToken()) - 1) < 0.01);
  const count = linkCount;
  const unknown = await call('POST', '/auth/forgot', { email: 'ninguem@x.com' }, undefined, { 'x-forwarded-for': '10.30.0.2' });
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.data, known.data); // mesmo corpo
  assert.equal(linkCount, count); // e nenhum e-mail para quem não existe
  // o link redefine a senha e a antiga deixa de funcionar
  assert.equal((await call('POST', '/auth/set-password', { token: tokenOf(lastLink), newPassword: 'frase-longa-redefinida-1' })).status, 200);
  assert.equal((await call('POST', '/auth/login', { email: 'esq@x.com', password: PW }, undefined, { 'x-forwarded-for': '10.30.0.3' })).status, 401);
  assert.ok((await login('esq@x.com', 'frase-longa-redefinida-1', { 'x-forwarded-for': '10.30.0.3' })).startsWith('session='));
});

test('esqueci minha senha: no máximo 3 e-mails por hora por conta (sem revelar o limite) e conta inativa não recebe', async () => {
  await addUser('lim@x.com', 'Lim', 'operator', PW);
  const bodies: unknown[] = [];
  const before = linkCount;
  for (let i = 0; i < 5; i++) bodies.push((await call('POST', '/auth/forgot', { email: 'lim@x.com' }, undefined, { 'x-forwarded-for': `10.31.0.${i}` })).data);
  assert.equal(linkCount - before, 3);
  assert.ok(bodies.every((b) => JSON.stringify(b) === JSON.stringify(bodies[0])));
  const id = await addUser('inat@x.com', 'Inat', 'operator', PW);
  await db.query(`update users set active = false where id = $1`, [id]);
  const c = linkCount;
  assert.equal((await call('POST', '/auth/forgot', { email: 'inat@x.com' }, undefined, { 'x-forwarded-for': '10.31.1.1' })).status, 200);
  assert.equal(linkCount, c);
});

test('auditoria registra convite, envio e definição de senha, sem o token', async () => {
  const events = (await db.query(`select action, detail, target from audit_log`)).rows as any[];
  const actions = new Set(events.map((e) => e.action));
  for (const a of ['user_created', 'password_link_sent', 'password_set', 'password_reset_requested', 'set_password_failed']) assert.ok(actions.has(a), `falta ${a}`);
  const all = JSON.stringify(events);
  assert.ok(!all.includes('#t=') && !/definir-senha/.test(all));
  assert.ok(!/[A-Za-z0-9_-]{43}/.test(all.replace(/"[^"]*(userId|invoiceId|lineId)[^"]*":"[^"]*"/g, '')), 'não deve haver token em nenhum registro');
});

test('formato inválido do e-mail no "esqueci minha senha" é 400 e não envia nada', async () => {
  const c = linkCount;
  assert.equal((await call('POST', '/auth/forgot', { email: 'não-é-email' }, undefined, { 'x-forwarded-for': '10.32.0.1' })).status, 400);
  assert.equal(linkCount, c);
});
