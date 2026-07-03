import { test, expect } from 'bun:test';
import { openDb, applySchema } from '../src/data/db';
import { insertAccount } from '../src/data/accounts';
import { encryptSecret } from '../src/credentials/crypto';
import { routeAndCall } from '../src/core/failover';
import type { ChatRequest } from '../src/adapters/types';

const KEY = 'a'.repeat(64);
function setup(n: number) {
  const db = openDb(':memory:'); applySchema(db);
  for (let i = 0; i < n; i++) {
    insertAccount(db, {
      name: `a${i}`, provider: 'glm', adapter: 'openai', baseUrl: 'https://x.test/v1',
      models: [{ public: 'm', target: 'm' }], weight: 1, egress: null, secretEnc: encryptSecret('sk', KEY),
    });
  }
  return db;
}
const REQ: ChatRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false };

test('first candidate 429 -> fails over to a healthy one', async () => {
  const db = setup(2);
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    return calls === 1
      ? new Response(JSON.stringify({ error: 'rl' }), { status: 429 })
      : new Response(JSON.stringify({ ok: 1 }), { status: 200 });
  }) as unknown as typeof fetch;
  const out = await routeAndCall(db, REQ, KEY, { fetchFn, rng: () => 0 });
  expect(out.ok).toBe(true);
  expect(out.attempts).toBe(2);
  expect((out.result!.json as any).ok).toBe(1);
});

test('network throw on a candidate rotates to the next', async () => {
  const db = setup(2);
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    if (calls === 1) throw new Error('ECONNREFUSED');
    return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
  }) as unknown as typeof fetch;
  const out = await routeAndCall(db, REQ, KEY, { fetchFn, rng: () => 0 });
  expect(out.ok).toBe(true);
  expect(out.attempts).toBe(2);
});

test('non-retryable 400 stops immediately (no failover)', async () => {
  const db = setup(2);
  const fetchFn = (async () => new Response(JSON.stringify({ e: 1 }), { status: 400 })) as unknown as typeof fetch;
  const out = await routeAndCall(db, REQ, KEY, { fetchFn, rng: () => 0 });
  expect(out.ok).toBe(false);
  expect(out.attempts).toBe(1);
  expect(out.lastError).toMatchObject({ httpStatus: 400, reason: 'bad_request' });
});

test('no account serving model -> noCandidates', async () => {
  const db = setup(1);
  const out = await routeAndCall(db, { ...REQ, model: 'missing' }, KEY,
    { fetchFn: (async () => new Response('{}')) as unknown as typeof fetch });
  expect(out).toMatchObject({ ok: false, noCandidates: true, attempts: 0 });
});

test('streaming: first 429 -> next returns a stream, committed', async () => {
  const db = setup(2);
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ error: 'rl' }), { status: 429 });
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('data: hi\n\n')); c.close(); } });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  const out = await routeAndCall(db, { ...REQ, stream: true }, KEY, { fetchFn, rng: () => 0 });
  expect(out.ok).toBe(true);
  expect(out.result!.stream).toBeDefined();
  expect(out.attempts).toBe(2);
});

test('applies cooling to the failed account', async () => {
  const db = setup(2);
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    return calls === 1
      ? new Response(JSON.stringify({}), { status: 429 })
      : new Response(JSON.stringify({ ok: 1 }), { status: 200 });
  }) as unknown as typeof fetch;
  await routeAndCall(db, REQ, KEY, { fetchFn, sessionId: 'fixed' }); // deterministic first pick via stickiness
  const statuses = db.query('SELECT status FROM account_state').all().map((r: any) => r.status).sort();
  expect(statuses).toContain('cooling'); // the 429'd account is cooling
});

test('failure outcome carries the last-attempted account (log attribution)', async () => {
  const db = setup(2);
  const fetchFn = (async () => new Response(JSON.stringify({ e: 1 }), { status: 400 })) as unknown as typeof fetch;
  const out = await routeAndCall(db, REQ, KEY, { fetchFn, sessionId: 'fixed' });
  expect(out.ok).toBe(false);
  expect(out.account?.id).toBeTruthy();
});

test('an account with an unregistered adapter is rotated past, not thrown', async () => {
  const db = openDb(':memory:'); applySchema(db);
  insertAccount(db, { name: 'bad', provider: 'x', adapter: 'bogus', baseUrl: 'https://x.test',
    models: [{ public: 'm', target: 'm' }], weight: 1, egress: null, secretEnc: encryptSecret('sk', KEY) });
  const out = await routeAndCall(db, REQ, KEY, { fetchFn: (async () => new Response('{}')) as unknown as typeof fetch });
  expect(out.ok).toBe(false);   // the only candidate was unusable
  expect(out.attempts).toBe(1); // it tried + rotated/stopped, did NOT throw (pre-fix this rejected)
});

test('stream request: bodyless-2xx account fails over and is marked cooling (not healthy)', async () => {
  const db = setup(2);
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    if (calls === 1) return new Response(null, { status: 200 }); // bodyless 2xx
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('data: hi\n\n')); c.close(); } });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  const out = await routeAndCall(db, { ...REQ, stream: true }, KEY, { fetchFn, sessionId: 'fixed' });
  expect(out.ok).toBe(true);
  expect(out.result!.stream).toBeDefined();
  expect(out.attempts).toBe(2);
  const statuses = db.query('SELECT status FROM account_state').all().map((r: any) => r.status).sort();
  expect(statuses).toContain('cooling'); // the bodyless-2xx account must be cooling, not falsely healthy
});
