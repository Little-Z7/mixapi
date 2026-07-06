import { test, expect } from 'bun:test';
import { openDb, applySchema } from '../src/data/db';
import { insertAccount } from '../src/data/accounts';
import { encryptSecret } from '../src/credentials/crypto';
import { countLogs } from '../src/usage/logger';
import { buildApp } from '../src/server';

const KEY = 'a'.repeat(64);
const ADMIN = 'admin-secret';

function setup(fetchFn: typeof fetch) {
  const db = openDb(':memory:'); applySchema(db);
  insertAccount(db, {
    name: 'oc', provider: 'opencode', adapter: 'openai', baseUrl: 'https://oc.test/v1',
    models: [{ public: 'm', target: 'm' }], weight: 1, egress: null, secretEnc: encryptSecret('k', KEY),
  });
  return { db, app: buildApp({ db, masterKeyHex: KEY, adminKey: ADMIN, fetchFn }) };
}
async function cookie(app: ReturnType<typeof setup>['app']) {
  const res = await app.request('/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: ADMIN }) });
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}
const okFetch = (async () => new Response(
  JSON.stringify({ choices: [{ message: { content: 'hi' } }], usage: { total_tokens: 3 } }),
  { status: 200, headers: { 'content-type': 'application/json' } },
)) as unknown as typeof fetch;
const errFetch = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;

test('POST /admin/test routes through the pool, reports the account, and does NOT log', async () => {
  const { db, app } = setup(okFetch);
  const ck = await cookie(app);
  const before = countLogs(db);
  const res = await app.request('/admin/test', {
    method: 'POST', headers: { cookie: ck, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', protocol: 'openai', message: 'hi' }),
  });
  expect(res.status).toBe(200);
  const j = await res.json();
  expect(j.ok).toBe(true);
  expect(typeof j.accountId).toBe('string');
  expect(j.httpStatus).toBe(200);
  expect(countLogs(db)).toBe(before); // playground must not write request_logs
});

test('POST /admin/test with no serving account → 404 no_candidates', async () => {
  const { app } = setup(okFetch);
  const ck = await cookie(app);
  const res = await app.request('/admin/test', {
    method: 'POST', headers: { cookie: ck, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'nope', message: 'hi' }),
  });
  expect(res.status).toBe(404);
  expect((await res.json()).status).toBe('no_candidates');
});

test('POST /admin/test surfaces an upstream error', async () => {
  const { app } = setup(errFetch);
  const ck = await cookie(app);
  const res = await app.request('/admin/test', {
    method: 'POST', headers: { cookie: ck, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', message: 'hi' }),
  });
  const j = await res.json();
  expect(j.ok).toBe(false);
  expect(j.status).toBe('error');
});

test('POST /admin/test requires an admin session', async () => {
  const { app } = setup(okFetch);
  const res = await app.request('/admin/test', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', message: 'hi' }),
  });
  expect(res.status).toBe(401);
});
