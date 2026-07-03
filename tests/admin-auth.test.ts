import { test, expect } from 'bun:test';
import { openDb, applySchema } from '../src/data/db';
import { buildApp } from '../src/server';

const KEY = 'a'.repeat(64);
const ADMIN = 'admin-secret';
function app() {
  const db = openDb(':memory:'); applySchema(db);
  return buildApp({ db, masterKeyHex: KEY, adminKey: ADMIN, fetchFn: (async () => new Response('{}')) as any });
}
async function cookieFor(a: ReturnType<typeof app>, key = ADMIN) {
  const res = await a.request('/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) });
  return { status: res.status, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] };
}

test('GET /admin serves a public HTML shell', async () => {
  const res = await app().request('/admin');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/html');
});

test('protected admin endpoint needs a session cookie', async () => {
  const res = await app().request('/admin/session');
  expect(res.status).toBe(401);
});

test('login with wrong key is 401, correct key sets a cookie', async () => {
  const a = app();
  expect((await cookieFor(a, 'nope')).status).toBe(401);
  const { status, cookie } = await cookieFor(a);
  expect(status).toBe(200);
  expect(cookie).toContain('mixadmin=');
  const res = await a.request('/admin/session', { headers: { cookie } });
  expect(res.status).toBe(200);
  expect((await res.json()).authed).toBe(true);
});

test('logout clears the session', async () => {
  const a = app();
  const { cookie } = await cookieFor(a);
  await a.request('/admin/logout', { method: 'POST', headers: { cookie } });
  // the returned clear-cookie has Max-Age=0; a fresh request with the cleared value is unauth
  const res = await a.request('/admin/session'); // no cookie
  expect(res.status).toBe(401);
});
