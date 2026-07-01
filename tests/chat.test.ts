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
