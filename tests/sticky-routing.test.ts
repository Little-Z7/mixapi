import { test, expect } from 'bun:test';
import { openDb, applySchema } from '../src/data/db';
import { importAccounts, type MixConfig } from '../src/config/load';
import { seedGatewayKey } from '../src/ingress/auth';
import { buildApp } from '../src/server';
import { deriveStickyKey } from '../src/core/sticky';

// ---- unit: deriveStickyKey (keys on tools + first user message; NOT the system prompt) ----
test('key is stable as the conversation grows (tools + first user constant)', () => {
  const t1 = { messages: [{ role: 'user', content: 'hello' }], tools: [{ type: 'function' }] };
  const t2 = { messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }, { role: 'user', content: 'more' }], tools: [{ type: 'function' }] };
  const a = deriveStickyKey(t1);
  expect(a).toMatch(/^pfx:/);
  expect(deriveStickyKey(t2)).toBe(a);
});

test('volatile system content does NOT change the key (robust to injected date/cwd/git-status)', () => {
  const a = deriveStickyKey({ system: 'coding agent. date 2026-07-06, git clean', messages: [{ role: 'user', content: 'refactor foo.ts' }] });
  const b = deriveStickyKey({ system: 'coding agent. date 2026-07-07, git 3 files changed', messages: [{ role: 'user', content: 'refactor foo.ts' }] });
  expect(a).toBeDefined();
  expect(a).toBe(b); // same conversation → same account despite a churning system prompt
});

test('different first user message → different key', () => {
  expect(deriveStickyKey({ messages: [{ role: 'user', content: 'alpha' }] }))
    .not.toBe(deriveStickyKey({ messages: [{ role: 'user', content: 'beta' }] }));
});

test('different tools → different key', () => {
  expect(deriveStickyKey({ messages: [{ role: 'user', content: 'x' }], tools: [{ name: 'a' }] }))
    .not.toBe(deriveStickyKey({ messages: [{ role: 'user', content: 'x' }], tools: [{ name: 'b' }] }));
});

test('no user message / empty / non-object → undefined (falls back to weighted random)', () => {
  expect(deriveStickyKey({ messages: [] })).toBeUndefined();
  expect(deriveStickyKey({ system: 'only system, no user' })).toBeUndefined();
  expect(deriveStickyKey({})).toBeUndefined();
  expect(deriveStickyKey(null)).toBeUndefined();
});

// ---- integration: 3 anthropic accounts on DISTINCT hosts (host identifies the account) ----
const KEY = 'a'.repeat(64);
const H = { authorization: 'Bearer gw', 'content-type': 'application/json' };
const CFG: MixConfig = { accounts: [
  { name: 'g1', provider: 'glm', adapter: 'anthropic', baseUrl: 'https://g1.test/anthropic', keyEnv: 'K1', models: [{ public: 'glm-x', target: 'glm-x' }] },
  { name: 'g2', provider: 'glm', adapter: 'anthropic', baseUrl: 'https://g2.test/anthropic', keyEnv: 'K2', models: [{ public: 'glm-x', target: 'glm-x' }] },
  { name: 'g3', provider: 'glm', adapter: 'anthropic', baseUrl: 'https://g3.test/anthropic', keyEnv: 'K3', models: [{ public: 'glm-x', target: 'glm-x' }] },
]};
function boot() {
  const db = openDb(':memory:'); applySchema(db); seedGatewayKey(db, 'gw');
  importAccounts(db, CFG, KEY, { K1: 'k', K2: 'k', K3: 'k' });
  return db;
}
function trackingFetch(hosts: string[]) {
  return (async (url: string) => {
    hosts.push(new URL(url).host);
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'hi' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

test('no x-session-id: identical prefix pins all 5 requests to ONE account (cache affinity)', async () => {
  const hosts: string[] = [];
  const app = buildApp({ db: boot(), masterKeyHex: KEY, fetchFn: trackingFetch(hosts) });
  const body = JSON.stringify({ model: 'glm-x', system: 'you are a coding agent', messages: [{ role: 'user', content: 'refactor foo.ts' }] });
  for (let i = 0; i < 5; i++) {
    const res = await app.request('/v1/messages', { method: 'POST', headers: H, body });
    expect(res.status).toBe(200);
  }
  expect(hosts).toHaveLength(5);
  expect(new Set(hosts).size).toBe(1); // all five landed on the same account
});

test('x-session-id takes precedence over the derived key (fixed header + VARYING body still pins)', async () => {
  const hosts: string[] = [];
  const app = buildApp({ db: boot(), masterKeyHex: KEY, fetchFn: trackingFetch(hosts) });
  // Vary the first user message each iteration → the derived key alone would scatter across
  // accounts; the fixed x-session-id must override it and pin every request to one account.
  for (let i = 0; i < 5; i++) {
    const body = JSON.stringify({ model: 'glm-x', messages: [{ role: 'user', content: 'msg-' + i }] });
    await app.request('/v1/messages', { method: 'POST', headers: { ...H, 'x-session-id': 'sess-42' }, body });
  }
  expect(hosts).toHaveLength(5);
  expect(new Set(hosts).size).toBe(1); // pinned by the header, not the (varying) derived key
});
