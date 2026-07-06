import { test, expect } from 'bun:test';
import { openDb, applySchema } from '../src/data/db';
import { insertAccount, listAccountsWithState, updateAccount, deleteAccount, setCredential, resetCooldown } from '../src/data/accounts';

function seed() {
  const db = openDb(':memory:'); applySchema(db);
  const id = insertAccount(db, {
    name: 'a', provider: 'glm', adapter: 'openai', baseUrl: 'https://x.test/v1',
    models: [{ public: 'm', target: 'm' }], weight: 1, egress: null, secretEnc: new Uint8Array([1]),
  });
  return { db, id };
}

test('listAccountsWithState returns account + state, never secretEnc', () => {
  const { db } = seed();
  const rows = listAccountsWithState(db);
  expect(rows.length).toBe(1);
  expect(rows[0].name).toBe('a');
  expect(rows[0].enabled).toBe(true);
  expect(rows[0].state.status).toBe('unknown');
  expect((rows[0] as any).secretEnc).toBeUndefined();
});

test('updateAccount changes provided fields only (incl. egress)', () => {
  const { db, id } = seed();
  updateAccount(db, id, { weight: 5, enabled: false, baseUrl: 'https://y.test/v1', egress: '1.2.3.4' });
  const r = listAccountsWithState(db)[0];
  expect(r.weight).toBe(5);
  expect(r.enabled).toBe(false);
  expect(r.baseUrl).toBe('https://y.test/v1');
  expect(r.egress).toBe('1.2.3.4');
  expect(r.models[0].public).toBe('m'); // untouched
  updateAccount(db, id, { egress: null }); // clearable back to null
  expect(listAccountsWithState(db)[0].egress).toBeNull();
});

test('deleteAccount removes account, credential and state', () => {
  const { db, id } = seed();
  deleteAccount(db, id);
  expect(listAccountsWithState(db).length).toBe(0);
  expect((db.query('SELECT COUNT(*) AS n FROM credentials').get() as any).n).toBe(0);
  expect((db.query('SELECT COUNT(*) AS n FROM account_state').get() as any).n).toBe(0);
});

test('setCredential replaces the stored secret', () => {
  const { db, id } = seed();
  setCredential(db, id, new Uint8Array([9, 9]));
  const row = db.query('SELECT secret_enc FROM credentials WHERE account_id=?').get(id) as any;
  expect(Array.from(row.secret_enc as Uint8Array)).toEqual([9, 9]);
});

test('resetCooldown clears cooling state', () => {
  const { db, id } = seed();
  db.query("UPDATE account_state SET status='cooling', cooldown_until=999, consecutive_errors=3 WHERE account_id=?").run(id);
  resetCooldown(db, id);
  const s = db.query('SELECT status,cooldown_until,consecutive_errors FROM account_state WHERE account_id=?').get(id) as any;
  expect(s).toMatchObject({ status: 'unknown', cooldown_until: null, consecutive_errors: 0 });
});
