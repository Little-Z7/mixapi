import { test, expect } from 'bun:test';
import { openDb, applySchema } from '../src/data/db';
import { buildApp } from '../src/server';

const KEY = 'a'.repeat(64);
const ADMIN = 'admin-secret';

function setup(fetchFn: typeof fetch) {
  const db = openDb(':memory:'); applySchema(db);
  return buildApp({ db, masterKeyHex: KEY, adminKey: ADMIN, fetchFn });
}
async function cookie(app: ReturnType<typeof setup>) {
  const res = await app.request('/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: ADMIN }) });
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}
function detect(app: ReturnType<typeof setup>, ck: string, body: unknown) {
  return app.request('/admin/detect-models', { method: 'POST', headers: { cookie: ck, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

test('detect-models returns model ids from an openai-style /models response', async () => {
  const okFetch = (async () => new Response(JSON.stringify({ data: [{ id: 'gpt-x' }, { id: 'gpt-y' }] }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  const app = setup(okFetch);
  const j = await (await detect(app, await cookie(app), { adapter: 'openai', baseUrl: 'https://x/v1', key: 'k' })).json();
  expect(j.ok).toBe(true);
  expect(j.models).toEqual(['gpt-x', 'gpt-y']);
});

test('detect-models (anthropic) sends x-api-key + anthropic-version and hits {baseUrl}/models', async () => {
  let seen: any = {};
  const capFetch = (async (url: string, opts: any) => {
    seen = { url, headers: opts.headers };
    return new Response(JSON.stringify({ data: [{ id: 'glm-4.6' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const app = setup(capFetch);
  const j = await (await detect(app, await cookie(app), { adapter: 'anthropic', baseUrl: 'https://z.test/api/anthropic', key: 'k9' })).json();
  expect(j.models).toEqual(['glm-4.6']);
  expect(seen.url).toBe('https://z.test/api/anthropic/models');
  expect(seen.headers['x-api-key']).toBe('k9');
  expect(seen.headers['anthropic-version']).toBe('2023-06-01');
});

test('detect-models: non-2xx upstream → ok:false with a helpful message (no throw)', async () => {
  const errFetch = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
  const app = setup(errFetch);
  const j = await (await detect(app, await cookie(app), { adapter: 'openai', baseUrl: 'https://x/v1', key: 'k' })).json();
  expect(j.ok).toBe(false);
  expect(j.error).toContain('404');
});

test('detect-models: a network failure is caught → ok:false (no crash)', async () => {
  const throwFetch = (async () => { throw new Error('boom'); }) as unknown as typeof fetch;
  const app = setup(throwFetch);
  const j = await (await detect(app, await cookie(app), { adapter: 'openai', baseUrl: 'https://x/v1', key: 'k' })).json();
  expect(j.ok).toBe(false);
});

test('detect-models requires an admin session (401) and a key (400)', async () => {
  const app = setup((async () => new Response('{}')) as unknown as typeof fetch);
  const noAuth = await app.request('/admin/detect-models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ adapter: 'openai', baseUrl: 'https://x/v1', key: 'k' }) });
  expect(noAuth.status).toBe(401);
  const noKey = await detect(app, await cookie(app), { adapter: 'openai', baseUrl: 'https://x/v1' });
  expect(noKey.status).toBe(400);
});
