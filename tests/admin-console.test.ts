import { test, expect } from 'bun:test';
import { openDb, applySchema } from '../src/data/db';
import { buildApp } from '../src/server';
import { insertAccount } from '../src/data/accounts';
import { encryptSecret } from '../src/credentials/crypto';

const KEY = 'a'.repeat(64);              // valid 32-byte hex master key
const ADMIN = 'admin-secret';

function appWith(seed = false) {
  const db = openDb(':memory:'); applySchema(db);
  if (seed) {
    insertAccount(db, {
      name: 'glm-1', provider: 'zhipu', adapter: 'anthropic',
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      models: [{ public: 'glm-4.6', target: 'glm-4.6' }], weight: 1, egress: null,
      secretEnc: encryptSecret('sk-should-never-appear', KEY),
    });
  }
  return buildApp({ db, masterKeyHex: KEY, adminKey: ADMIN });
}

test('GET /admin serves 200 HTML with the login view, app shell, and all five tab labels', async () => {
  const res = await appWith().request('/admin');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type') ?? '').toContain('text/html');
  const html = await res.text();
  expect(html).toContain('id="login"');           // login view present
  expect(html).toContain('id="app"');             // app view present
  for (const t of ['账号池', '日志', '用量', '密钥', '调试台']) expect(html).toContain(t);
});

test('GET /admin is static — identical regardless of DB contents and leaks no secret', async () => {
  const empty = await (await appWith(false).request('/admin')).text();
  const seeded = await (await appWith(true).request('/admin')).text();
  expect(seeded).toBe(empty);                      // no server-side interpolation
  expect(seeded).not.toContain('sk-should-never-appear');
  expect(seeded).not.toContain(ADMIN);
  expect(seeded).not.toContain(KEY);
});

test('GET /admin wires the auth flow and the four tab buttons', async () => {
  const html = await (await appWith().request('/admin')).text();
  // auth endpoints exist in the skeleton (Task 1); data endpoints are added in Tasks 2–3
  for (const p of ['/admin/login', '/admin/session', '/admin/logout']) expect(html).toContain(p);
  for (const t of ['pool', 'logs', 'stats', 'keys']) expect(html).toContain(`data-tab="${t}"`);
});
