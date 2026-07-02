import { test, expect } from 'bun:test';
import { openDb, applySchema } from '../src/data/db';
import { insertAccount } from '../src/data/accounts';
import { encryptSecret } from '../src/credentials/crypto';
import { seedGatewayKey } from '../src/ingress/auth';
import { buildApp } from '../src/server';

const KEY = 'a'.repeat(64);
function addAcct(db: any, name: string, adapter: string, model: string) {
  insertAccount(db, {
    name, provider: 'p', adapter, baseUrl: 'https://up.test',
    models: [{ public: model, target: model }], weight: 1, egress: null,
    secretEnc: encryptSecret('sk', KEY),
  });
}
function setup() {
  const db = openDb(':memory:'); applySchema(db); seedGatewayKey(db, 'gw');
  return db;
}

test('401 without gateway key', async () => {
  const db = setup();
  const app = buildApp({ db, masterKeyHex: KEY, fetchFn: (async () => new Response('{}')) as any });
  const res = await app.request('/v1/messages', { method: 'POST', body: '{}' });
  expect(res.status).toBe(401);
});

test('pools anthropic accounts and fails over (Anthropic passthrough)', async () => {
  const db = setup();
  addAcct(db, 'glm-a', 'anthropic', 'glm-5.2');
  addAcct(db, 'glm-b', 'anthropic', 'glm-5.2');
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    return calls === 1
      ? new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }), { status: 429 })
      : new Response(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'hi' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const app = buildApp({ db, masterKeyHex: KEY, fetchFn });
  const res = await app.request('/v1/messages', {
    method: 'POST', headers: { authorization: 'Bearer gw', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.2', stream: false, messages: [{ role: 'user', content: [{ type: 'text', text: 'hey' }] }] }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).content[0].text).toBe('hi'); // Anthropic-shaped passthrough
  const log = db.query('SELECT attempt_count FROM request_logs ORDER BY ts DESC LIMIT 1').get() as any;
  expect(log.attempt_count).toBe(2);
});

test('protocol isolation: /v1/messages never routes to an openai account for a shared model', async () => {
  const db = setup();
  addAcct(db, 'oc-openai', 'openai', 'glm-5.2'); // same model, wrong protocol
  const app = buildApp({ db, masterKeyHex: KEY, fetchFn: (async () => new Response('{}')) as any });
  const res = await app.request('/v1/messages', {
    method: 'POST', headers: { authorization: 'Bearer gw', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.2', messages: [] }),
  });
  expect(res.status).toBe(404); // no anthropic candidate → not_found (never picks the openai account)
  expect((await res.json()).type).toBe('error');
});

test('malformed JSON -> 400 anthropic-shaped', async () => {
  const db = setup();
  const app = buildApp({ db, masterKeyHex: KEY, fetchFn: (async () => new Response('{}')) as any });
  const res = await app.request('/v1/messages', {
    method: 'POST', headers: { authorization: 'Bearer gw', 'content-type': 'application/json' }, body: 'not json{',
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error.type).toBe('invalid_request_error');
});
