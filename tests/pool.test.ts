import { test, expect } from 'bun:test';
import { openDb, applySchema } from '../src/data/db';
import { insertAccount } from '../src/data/accounts';
import { listCandidates } from '../src/core/pool';

function db2() { const d = openDb(':memory:'); applySchema(d); return d; }
function add(db: any, name: string, model: string) {
  return insertAccount(db, {
    name, provider: 'glm', adapter: 'openai', baseUrl: 'https://x.test/v1',
    models: [{ public: model, target: model }], weight: 1, egress: null, secretEnc: new Uint8Array([1]),
  });
}
function setState(db: any, id: string, status: string, cooldown: number | null) {
  db.query('UPDATE account_state SET status=?, cooldown_until=? WHERE account_id=?').run(status, cooldown, id);
}

test('lists enabled accounts serving the model', () => {
  const db = db2();
  add(db, 'a', 'gpt'); add(db, 'b', 'gpt'); add(db, 'c', 'other');
  const got = listCandidates(db, 'gpt').map((c) => c.name).sort();
  expect(got).toEqual(['a', 'b']);
});

test('excludes disabled', () => {
  const db = db2();
  const a = add(db, 'a', 'gpt'); add(db, 'b', 'gpt');
  setState(db, a, 'disabled', null);
  expect(listCandidates(db, 'gpt').map((c) => c.name)).toEqual(['b']);
});

test('cooling account re-admitted after cooldown passes', () => {
  const db = db2();
  const a = add(db, 'a', 'gpt');
  setState(db, a, 'cooling', 5000);
  expect(listCandidates(db, 'gpt', 4000)).toEqual([]);      // still cooling
  expect(listCandidates(db, 'gpt', 6000).map((c) => c.name)).toEqual(['a']); // cooldown passed
});

test('candidate carries secretEnc and status', () => {
  const db = db2();
  add(db, 'a', 'gpt');
  const c = listCandidates(db, 'gpt')[0];
  expect(Array.from(c.secretEnc)).toEqual([1]);
  expect(c.status).toBe('unknown');
});

test('adapter filter selects only same-protocol accounts', () => {
  const db = db2();
  const a = add(db, 'oa', 'glm-5.2'); // add() defaults adapter 'openai'
  db.query("UPDATE accounts SET adapter='anthropic' WHERE id=?").run(add(db, 'an', 'glm-5.2'));
  expect(listCandidates(db, 'glm-5.2').length).toBe(2);            // no filter → both
  expect(listCandidates(db, 'glm-5.2', Date.now(), 'anthropic').map(c => c.name)).toEqual(['an']);
  expect(listCandidates(db, 'glm-5.2', Date.now(), 'openai').map(c => c.name)).toEqual(['oa']);
});
