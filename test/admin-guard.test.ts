import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { addUser, loadSchema, db } from './helpers.ts';

before(async () => {
  await loadSchema();
});

test('AUD-015: o banco impede ficar sem administrador ativo', async () => {
  const a = await addUser('solo@x.com', 'Solo', 'admin');
  await assert.rejects(db.query(`update users set active = false where id = $1`, [a]), /last_admin/);
  await assert.rejects(db.query(`update users set role = 'operator' where id = $1`, [a]), /last_admin/);
  const b = await addUser('segundo@x.com', 'Segundo', 'admin');
  await db.query(`update users set active = false where id = $1`, [b]); // há outro ativo: permitido
  await db.query(`update users set active = true where id = $1`, [b]);
  await db.query(`update users set active = false where id = $1`, [a]); // agora b é o outro ativo: permitido
  await assert.rejects(db.query(`update users set role = 'operator' where id = $1`, [b]), /last_admin/);
});
