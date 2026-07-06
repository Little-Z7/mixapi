import { test, expect } from 'bun:test';
import { openDb, applySchema } from '../src/data/db';
import { seedGatewayKey, hashKey } from '../src/ingress/auth';
import { insertAccount } from '../src/data/accounts';
import { encryptSecret } from '../src/credentials/crypto';
import { buildApp } from '../src/server';

const KEY = 'a'.repeat(64);
function setup() {
  const db = openDb(':memory:'); applySchema(db);
  seedGatewayKey(db, 'gw');
  insertAccount(db, {
    name: 'oc', provider: 'opencode', adapter: 'openai', baseUrl: 'https://oc.test/v1',
    models: [{ public: 'm', target: 'm' }], weight: 1, egress: null, secretEnc: encryptSecret('k', KEY),
  });
  return db;
}
const okFetch = (async () => new Response(
  JSON.stringify({ choices: [{ message: { content: 'hi' } }], usage: {} }),
  { status: 200, headers: { 'content-type': 'application/json' } },
)) as unknown as typeof fetch;

test('/v1 request logs the id of the gateway key that authorized it', async () => {
  const db = setup();
  const keyId = (db.query('SELECT id FROM gateway_keys WHERE key_hash=?').get(hashKey('gw')) as { id: string }).id;
  const app = buildApp({ db, masterKeyHex: KEY, fetchFn: okFetch });
  const res = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer gw', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
  });
  expect(res.status).toBe(200);
  const row = db.query('SELECT gateway_key_id FROM request_logs ORDER BY ts DESC LIMIT 1').get() as { gateway_key_id: string };
  expect(row.gateway_key_id).toBe(keyId);
});

test('invalid gateway key → 401 and nothing logged', async () => {
  const db = setup();
  const app = buildApp({ db, masterKeyHex: KEY, fetchFn: okFetch });
  const res = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer nope', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', messages: [] }),
  });
  expect(res.status).toBe(401);
  expect((db.query('SELECT COUNT(*) AS n FROM request_logs').get() as { n: number }).n).toBe(0);
});
