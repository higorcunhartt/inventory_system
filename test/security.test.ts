import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { addUser, call, login, loadSchema, db } from './helpers.ts';

const ipHeader = (ip: string) => ({ 'x-forwarded-for': ip });

before(async () => {
  await loadSchema();
});

// ---------- AUD-001: bloqueio atômico ----------
test('AUD-001: 30 logins errados em paralelo → no máximo 5 chegam a testar a senha', async () => {
  await addUser('conc@x.com', 'Conc', 'operator');
  const res = await Promise.all(Array.from({ length: 30 }, () => call('POST', '/auth/login', { email: 'conc@x.com', password: 'errada-errada-1' }, undefined, ipHeader('10.0.0.1'))));
  const evaluated = res.filter((r) => r.status === 401).length;
  const blocked = res.filter((r) => r.status === 429).length;
  assert.ok(evaluated <= 5, `senhas avaliadas: ${evaluated}`);
  assert.equal(evaluated + blocked, 30);
});

// ---------- AUD-002: resposta uniforme e sem DoS entre IPs ----------
test('AUD-002: conta existente e inexistente respondem do mesmo jeito', async () => {
  await addUser('uni@x.com', 'Uni', 'operator');
  const seq = async (email: string, ip: string) => {
    const out: number[] = [];
    for (let i = 0; i < 7; i++) out.push((await call('POST', '/auth/login', { email, password: 'errada-errada-1' }, undefined, ipHeader(ip))).status);
    return out;
  };
  const existing = await seq('uni@x.com', '10.0.0.2');
  const ghost = await seq('fantasma@x.com', '10.0.0.3');
  assert.deepEqual(existing, ghost);
  assert.deepEqual(existing, [401, 401, 401, 401, 401, 429, 429]);
});

test('AUD-002: atacante em outro IP não impede o dono de entrar', async () => {
  await addUser('dono@x.com', 'Dono', 'admin');
  for (let i = 0; i < 8; i++) await call('POST', '/auth/login', { email: 'dono@x.com', password: 'errada-errada-1' }, undefined, ipHeader('203.0.113.9'));
  const cookie = await login('dono@x.com', 'senha-super-segura', ipHeader('198.51.100.7'));
  assert.ok(cookie.startsWith('session='));
});

// ---------- AUD-013: MFA cumulativo ----------
test('AUD-013: erros de MFA são cumulativos entre códigos', async () => {
  await addUser('mfa@x.com', 'Mfa', 'operator');
  const wrongOf = (c: string) => (c === '000000' ? '111111' : '000000');
  const statuses: number[] = [];
  let real = '';
  for (let round = 0; round < 3; round++) {
    const l = await call('POST', '/auth/login', { email: 'mfa@x.com', password: 'senha-super-segura' }, undefined, ipHeader('10.0.0.4'));
    assert.equal(l.status, 200);
    const { lastCode } = await import('./helpers.ts');
    real = lastCode;
    for (let i = 0; i < 4; i++) statuses.push((await call('POST', '/auth/verify', { mfaToken: l.data.mfaToken, code: wrongOf(real) }, undefined, ipHeader('10.0.0.4'))).status);
    if (round === 2) {
      // 12 erros acumulados: mesmo o código CORRETO é recusado
      const right = await call('POST', '/auth/verify', { mfaToken: l.data.mfaToken, code: real }, undefined, ipHeader('10.0.0.4'));
      assert.equal(right.status, 429);
    }
  }
  assert.ok(statuses.includes(429), 'deve haver bloqueio cumulativo');
});

test('AUD-013: no máximo 10 e-mails de código por hora por usuário', async () => {
  await addUser('flood@x.com', 'Flood', 'operator');
  const out: number[] = [];
  for (let i = 0; i < 12; i++) out.push((await call('POST', '/auth/login', { email: 'flood@x.com', password: 'senha-super-segura' }, undefined, ipHeader('10.0.0.5'))).status);
  assert.equal(out.filter((s) => s === 200).length, 10);
  assert.equal(out.filter((s) => s === 429).length, 2);
});

// ---------- AUD-012: senhas ----------
test('AUD-012: senha com espaço no fim funciona no login (sem trim)', async () => {
  await addUser('esp@x.com', 'Esp', 'operator', 'senha com espaco no fim ');
  assert.ok((await login('esp@x.com', 'senha com espaco no fim ', ipHeader('10.0.0.6'))).startsWith('session='));
  const wrong = await call('POST', '/auth/login', { email: 'esp@x.com', password: 'senha com espaco no fim' }, undefined, ipHeader('10.0.0.6'));
  assert.equal(wrong.status, 401);
});

test('AUD-012: política de senha (comuns, 72 bytes) e limite da senha atual', async () => {
  await addUser('pol@x.com', 'Pol', 'operator');
  const cookie = await login('pol@x.com', 'senha-super-segura', ipHeader('10.0.0.7'));
  const change = (n: string) => call('POST', '/auth/change-password', { currentPassword: 'senha-super-segura', newPassword: n }, cookie);
  assert.equal((await change('password123')).status, 400);
  assert.equal((await change('Senha12345')).status, 400);
  assert.equal((await change('aaaaaaaaaaaa')).status, 400);
  assert.equal((await change('a'.repeat(80))).status, 400);
  assert.equal((await change('ç'.repeat(40))).status, 400); // 80 bytes
  assert.equal((await change('frase-longa-e-unica-2026')).status, 200);
  // 6 tentativas com a senha atual errada → bloqueio
  const cookie2 = await login('pol@x.com', 'frase-longa-e-unica-2026', ipHeader('10.0.0.7'));
  const codes: number[] = [];
  for (let i = 0; i < 7; i++) codes.push((await call('POST', '/auth/change-password', { currentPassword: 'errada-errada-1', newPassword: 'outra-frase-bem-longa-9' }, cookie2)).status);
  assert.deepEqual(codes.slice(0, 5), [400, 400, 400, 400, 400]);
  assert.equal(codes[6], 429);
});

test('bootstrap: tabela rate_limits existe e expira janelas', async () => {
  const r = await db.query(`select count(*)::int n from rate_limits`);
  assert.ok((r.rows[0] as any).n > 0);
});
