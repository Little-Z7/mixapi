import { test, expect } from 'bun:test';
import { openDb, applySchema } from '../src/data/db';
import { buildApp } from '../src/server';

const KEY = 'a'.repeat(64);
const ADMIN = 'admin-secret';
function setup() {
  const db = openDb(':memory:'); applySchema(db);
  const app = buildApp({ db, masterKeyHex: KEY, adminKey: ADMIN, fetchFn: (async () => new Response('{}')) as any });
  return { db, app };
}
async function cookie(app: any) {
  const res = await app.request('/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: ADMIN }) });
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}
const J = (ck: string) => ({ cookie: ck, 'content-type': 'application/json' });

test('create -> list (no secret) -> patch -> delete account', async () => {
  const { db, app } = setup(); const ck = await cookie(app);
  const create = await app.request('/admin/accounts', { method: 'POST', headers: J(ck), body: JSON.stringify({ name: 'glm-1', provider: 'glm', adapter: 'anthropic', baseUrl: 'https://z.test/api/anthropic', models: [{ public: 'glm-5.2', target: 'glm-5.2' }], weight: 1, key: 'sk-real' }) });
  expect(create.status).toBe(201);
  const id = (await create.json()).id;

  const listRes = await app.request('/admin/accounts', { headers: { cookie: ck } });
  const list = await listRes.json();
  expect(list[0].name).toBe('glm-1');
  expect(JSON.stringify(list)).not.toContain('sk-real');       // secret never returned
  expect(JSON.stringify(list)).not.toContain('secretEnc');
  // stored encrypted:
  const enc = db.query('SELECT secret_enc FROM credentials WHERE account_id=?').get(id) as any;
  expect(new TextDecoder().decode(enc.secret_enc)).not.toContain('sk-real');

  await app.request(`/admin/accounts/${id}`, { method: 'PATCH', headers: J(ck), body: JSON.stringify({ weight: 7 }) });
  expect((await (await app.request('/admin/accounts', { headers: { cookie: ck } })).json())[0].weight).toBe(7);

  await app.request(`/admin/accounts/${id}`, { method: 'DELETE', headers: { cookie: ck } });
  expect((await (await app.request('/admin/accounts', { headers: { cookie: ck } })).json()).length).toBe(0);
});

test('gateway-key: create returns raw once, list masked, revoke', async () => {
  const { app } = setup(); const ck = await cookie(app);
  const res = await app.request('/admin/gateway-keys', { method: 'POST', headers: J(ck), body: JSON.stringify({ name: 'ci' }) });
  const { id, key } = await res.json();
  expect(key).toMatch(/^mk-/);
  const list = await (await app.request('/admin/gateway-keys', { headers: { cookie: ck } })).json();
  expect(JSON.stringify(list)).not.toContain(key);
  await app.request(`/admin/gateway-keys/${id}`, { method: 'DELETE', headers: { cookie: ck } });
  expect((await (await app.request('/admin/gateway-keys', { headers: { cookie: ck } })).json()).length).toBe(0);
});

test('logs + stats endpoints require auth and return data', async () => {
  const { app } = setup();
  expect((await app.request('/admin/stats')).status).toBe(401);
  const ck = await cookie(app);
  expect((await app.request('/admin/stats', { headers: { cookie: ck } })).status).toBe(200);
  expect((await app.request('/admin/logs', { headers: { cookie: ck } })).status).toBe(200);
  expect((await app.request('/admin/models', { headers: { cookie: ck } })).status).toBe(200);
});

test('POST /admin/accounts rejects an unknown adapter with 400', async () => {
  const { app } = setup(); const ck = await cookie(app);
  const res = await app.request('/admin/accounts', { method: 'POST', headers: J(ck),
    body: JSON.stringify({ name: 'x', provider: 'p', adapter: 'nope', baseUrl: 'https://x.test', models: [], weight: 1, key: 'sk' }) });
  expect(res.status).toBe(400);
});

test('POST /admin/accounts with malformed JSON -> 400 not 500', async () => {
  const { app } = setup(); const ck = await cookie(app);
  const res = await app.request('/admin/accounts', { method: 'POST', headers: J(ck), body: 'not json{' });
  expect(res.status).toBe(400);
});

test('every /admin/* data route requires a session cookie', async () => {
  const { app } = setup();
  const routes: [string, string][] = [
    ['GET', '/admin/accounts'], ['POST', '/admin/accounts'], ['PATCH', '/admin/accounts/x'],
    ['DELETE', '/admin/accounts/x'], ['POST', '/admin/accounts/x/reset-cooldown'],
    ['GET', '/admin/gateway-keys'], ['POST', '/admin/gateway-keys'], ['DELETE', '/admin/gateway-keys/x'],
    ['GET', '/admin/logs'], ['GET', '/admin/stats'], ['GET', '/admin/models'],
  ];
  for (const [method, path] of routes) {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
    expect(res.status).toBe(401);
  }
});
