import { test, expect } from 'bun:test';
import { openDb, applySchema } from '../src/data/db';
import { insertAccount } from '../src/data/accounts';
import { encryptSecret } from '../src/credentials/crypto';
import { seedGatewayKey } from '../src/ingress/auth';
import { countLogs } from '../src/usage/logger';
import { buildApp } from '../src/server';

const KEY = 'a'.repeat(64);

function setup() {
  const db = openDb(':memory:');
  applySchema(db);
  seedGatewayKey(db, 'gw');
  insertAccount(db, {
    name: 'glm', provider: 'glm', adapter: 'openai', baseUrl: 'https://up.test/v1',
    models: [{ public: 'glm-4.6', target: 'glm-real' }], weight: 1, egress: null,
    secretEnc: encryptSecret('sk-up', KEY),
  });
  return db;
}

test('401 without valid gateway key', async () => {
  const db = setup();
  const app = buildApp({ db, masterKeyHex: KEY, fetchFn: (async () => new Response('{}')) as unknown as typeof fetch });
  const res = await app.request('/v1/chat/completions', { method: 'POST', body: '{}' });
  expect(res.status).toBe(401);
});

test('GET /v1/models lists public names', async () => {
  const db = setup();
  const app = buildApp({ db, masterKeyHex: KEY });
  const res = await app.request('/v1/models', { headers: { authorization: 'Bearer gw' } });
  const body = await res.json();
  expect(body.data.map((m: { id: string }) => m.id)).toEqual(['glm-4.6']);
});

test('non-stream chat proxies to upstream and logs', async () => {
  const db = setup();
  const upstreamJson = { id: 'x', choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } };
  let seenBody: any = null;
  const fetchFn = (async (_url: string, init: RequestInit) => {
    seenBody = JSON.parse(init.body as string);
    return new Response(JSON.stringify(upstreamJson), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const app = buildApp({ db, masterKeyHex: KEY, fetchFn });
  const res = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer gw', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-4.6', messages: [{ role: 'user', content: 'hey' }] }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).choices[0].message.content).toBe('hi');
  expect(seenBody.model).toBe('glm-real'); // adapter renamed public->target
  expect(countLogs(db)).toBe(1);
});

test('stream chat pipes SSE through', async () => {
  const db = setup();
  const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
  const fetchFn = (async () => new Response(
    new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  )) as unknown as typeof fetch;
  const app = buildApp({ db, masterKeyHex: KEY, fetchFn });
  const res = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer gw', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-4.6', stream: true, messages: [{ role: 'user', content: 'hey' }] }),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  expect(await res.text()).toContain('"content":"hi"');
});

test('missing model -> 404 no-account', async () => {
  const db = setup();
  const app = buildApp({ db, masterKeyHex: KEY, fetchFn: (async () => new Response('{}')) as unknown as typeof fetch });
  const res = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer gw', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'does-not-exist', messages: [] }),
  });
  expect(res.status).toBe(404);
});

test('stream request with bodyless 2xx upstream -> 502, not 2xx-with-error-body', async () => {
  const db = setup();
  const fetchFn = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
  const app = buildApp({ db, masterKeyHex: KEY, fetchFn });
  const res = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer gw', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-4.6', stream: true, messages: [{ role: 'user', content: 'hey' }] }),
  });
  expect(res.status).toBe(502);
  expect((await res.json()).error.type).toBe('bad_gateway');
});

test('upstream network failure -> 502 and a failure is logged', async () => {
  const db = setup();
  const fetchFn = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
  const app = buildApp({ db, masterKeyHex: KEY, fetchFn });
  const res = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer gw', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-4.6', messages: [{ role: 'user', content: 'hey' }] }),
  });
  expect(res.status).toBe(502);
  expect((await res.json()).error.type).toBe('bad_gateway');
  expect(countLogs(db)).toBe(1);
});

test('malformed JSON body -> 400', async () => {
  const db = setup();
  const app = buildApp({ db, masterKeyHex: KEY, fetchFn: (async () => new Response('{}')) as unknown as typeof fetch });
  const res = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer gw', 'content-type': 'application/json' },
    body: 'not json{',
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error.type).toBe('bad_request');
});

test('pool: first account 429 -> transparently served by second, attempt_count=2', async () => {
  const db = openDb(':memory:'); applySchema(db); seedGatewayKey(db, 'gw');
  for (const n of ['a', 'b']) {
    insertAccount(db, {
      name: n, provider: 'glm', adapter: 'openai', baseUrl: 'https://up.test/v1',
      models: [{ public: 'glm-4.6', target: 'glm-real' }], weight: 1, egress: null,
      secretEnc: encryptSecret('sk-up', KEY),
    });
  }
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    return calls === 1
      ? new Response(JSON.stringify({ error: 'rl' }), { status: 429 })
      : new Response(JSON.stringify({ id: 'x', choices: [{ message: { role: 'assistant', content: 'hi' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const app = buildApp({ db, masterKeyHex: KEY, fetchFn });
  const res = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer gw', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-4.6', messages: [{ role: 'user', content: 'hey' }] }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).choices[0].message.content).toBe('hi');
  const log = db.query('SELECT attempt_count FROM request_logs ORDER BY ts DESC LIMIT 1').get() as any;
  expect(log.attempt_count).toBe(2);
});

test('failed request logs a non-null account_id (attribution)', async () => {
  const db = openDb(':memory:'); applySchema(db); seedGatewayKey(db, 'gw');
  insertAccount(db, {
    name: 'a', provider: 'glm', adapter: 'openai', baseUrl: 'https://up.test/v1',
    models: [{ public: 'glm-4.6', target: 'glm-real' }], weight: 1, egress: null,
    secretEnc: encryptSecret('sk-up', KEY),
  });
  const fetchFn = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
  const app = buildApp({ db, masterKeyHex: KEY, fetchFn });
  const res = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer gw', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-4.6', messages: [{ role: 'user', content: 'hey' }] }),
  });
  expect(res.status).toBe(502);
  const log = db.query('SELECT account_id FROM request_logs ORDER BY ts DESC LIMIT 1').get() as any;
  expect(log.account_id).toBeTruthy();
});

test('protocol isolation: /v1/chat/completions never routes to an anthropic account for a shared model', async () => {
  const db = openDb(':memory:'); applySchema(db); seedGatewayKey(db, 'gw');
  // ONLY an anthropic account serves this model; the openai filter must exclude it -> no candidates -> 404
  insertAccount(db, {
    name: 'glm-only', provider: 'glm', adapter: 'anthropic', baseUrl: 'https://glm.test/api/anthropic',
    models: [{ public: 'glm-5.2', target: 'glm-5.2' }], weight: 1, egress: null,
    secretEnc: encryptSecret('sk', KEY),
  });
  const app = buildApp({ db, masterKeyHex: KEY, fetchFn: (async () => new Response('{}')) as unknown as typeof fetch });
  const res = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer gw', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.2', messages: [] }),
  });
  expect(res.status).toBe(404); // openai-filter yields zero candidates; the anthropic account is never selected
});
