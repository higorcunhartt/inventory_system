import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { call, db, login } from './helpers.ts';

const { splitSql } = await import('../scripts/sql-split.mjs');
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('migração: banco legado (esquema original + dados) é atualizado sem perda e de forma idempotente', async () => {
  // 1) esquema ORIGINAL (commit bf4b222) com dados reais-like
  for (const stmt of splitSql(read('./fixtures/schema-v1.sql'))) await db.query(stmt);
  const { hashPassword } = await import('../netlify/lib/auth.ts');
  const hash = await hashPassword('senha-super-segura');
  const admin = (await db.query(`insert into users (email, name, password_hash, role) values ('legado@x.com', 'Legado', $1, 'admin') returning id`, [hash])).rows[0] as any;
  const line = (await db.query(`insert into lines (number, carrier, line_type, account, assignee_name) values ('11987654321', 'Vivo', 'DADOS_VOZ', '0371235565', 'Maria') returning id`)).rows[0] as any;
  await db.query(`insert into line_history (line_id, action, assignee_name, changed_by_name) values ($1, 'create', 'Maria', 'Carga')`, [line.id]);
  const inv = (await db.query(`insert into invoices (carrier, reference_month, filename, file_hash, total_amount, uploaded_by) values ('Vivo', '2026-05-01', 'legado.csv', 'abc', 10, 'Carga') returning id`)).rows[0] as any;
  await db.query(`insert into consumption (invoice_id, number, voice_minutes, data_mb, amount) values ($1, '11987654321', 10, 100, 10)`, [inv.id]);

  // 2) novo esquema, aplicado DUAS vezes (idempotência)
  const target = splitSql(read('../db/schema.sql'));
  for (let pass = 0; pass < 2; pass++) for (const stmt of target) await db.query(stmt);

  // 3) dados legados intactos
  const counts = async (t: string) => ((await db.query(`select count(*)::int n from ${t}`)).rows[0] as any).n;
  assert.equal(await counts('users'), 1);
  assert.equal(await counts('lines'), 1);
  assert.equal(await counts('line_history'), 1);
  assert.equal(await counts('invoices'), 1);
  assert.equal(await counts('consumption'), 1);

  // 4) colunas e tabelas novas com valores padrão corretos
  const u = (await db.query(`select token_version, must_change_password from users where id = $1`, [admin.id])).rows[0] as any;
  assert.equal(u.token_version, 0);
  assert.equal(u.must_change_password, false);
  assert.equal(((await db.query(`select account from invoices where id = $1`, [inv.id])).rows[0] as any).account, null);
  for (const t of ['rate_limits', 'audit_log']) assert.equal(await counts(t), 0);

  // 5) índice único de faturas aceita legados sem conta e bloqueia duplicata (operadora, conta, mês)
  await db.query(`insert into invoices (carrier, account, reference_month, filename, file_hash) values ('Vivo', null, '2026-05-01', 'outro-legado.csv', 'def')`);
  await db.query(`insert into invoices (carrier, account, reference_month, filename, file_hash) values ('Vivo', '0371235565', '2026-06-01', 'novo.csv', 'ghi')`);
  await assert.rejects(db.query(`insert into invoices (carrier, account, reference_month, filename, file_hash) values ('VIVO', '0371235565', '2026-06-01', 'dup.csv', 'jkl')`), /invoices_account_month_uq|unique/i);

  // 6) gatilho do último administrador ativo
  await assert.rejects(db.query(`update users set active = false where id = $1`, [admin.id]), /last_admin/);

  // 7) o sistema funciona de ponta a ponta sobre o banco migrado
  const cookie = await login('legado@x.com');
  assert.equal((await call('GET', '/lines', undefined, cookie)).data.lines.length, 1);
  assert.equal((await call('GET', '/audit?limit=3', undefined, cookie)).status, 200);
});
