import { test, expect } from 'bun:test';
import { openDb, applySchema } from '../src/data/db';
import { importAccounts, type MixConfig } from '../src/config/load';
import { seedGatewayKey } from '../src/ingress/auth';
import { buildApp } from '../src/server';

const KEY = 'a'.repeat(64);
const CFG: MixConfig = { accounts: [
  { name: 'glm-1', provider: 'glm', adapter: 'anthropic', baseUrl: 'https://glm.test/api/anthropic', keyEnv: 'G1', models: [{ public: 'glm-5.2', target: 'glm-5.2' }] },
  { name: 'glm-2', provider: 'glm', adapter: 'anthropic', baseUrl: 'https://glm.test/api/anthropic', keyEnv: 'G2', models: [{ public: 'glm-5.2', target: 'glm-5.2' }] },
  { name: 'oc-1', provider: 'opencode', adapter: 'openai', baseUrl: 'https://oc.test/zen/go/v1', keyEnv: 'O1', models: [{ public: 'glm-5.2', target: 'glm-5.2' }, { public: 'deepseek-v4', target: 'deepseek-v4' }] },
  { name: 'oc-2', provider: 'opencode', adapter: 'openai', baseUrl: 'https://oc.test/zen/go/v1', keyEnv: 'O2', models: [{ public: 'deepseek-v4', target: 'deepseek-v4' }] },
]};
function boot() {
  const db = openDb(':memory:'); applySchema(db); seedGatewayKey(db, 'gw');
  importAccounts(db, CFG, KEY, { G1: 'k', G2: 'k', O1: 'k', O2: 'k' });
  return db;
}
// records which base_url host was actually called
function trackingFetch(hosts: string[]) {
  return (async (url: string) => {
    hosts.push(new URL(url).host);
    return new Response(JSON.stringify({ ok: 1, content: [{ type: 'text', text: 'hi' }], choices: [{ message: { content: 'hi' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}
const H = { authorization: 'Bearer gw', 'content-type': 'application/json' };

test('/v1/messages glm-5.2 routes ONLY to a GLM (anthropic) upstream', async () => {
  const db = boot(); const hosts: string[] = [];
  const app = buildApp({ db, masterKeyHex: KEY, fetchFn: trackingFetch(hosts) });
  const res = await app.request('/v1/messages', { method: 'POST', headers: H, body: JSON.stringify({ model: 'glm-5.2', messages: [] }) });
  expect(res.status).toBe(200);
  expect(hosts).toEqual(['glm.test']); // never oc.test, even though oc-1 also serves glm-5.2
});

test('/v1/chat/completions glm-5.2 routes ONLY to an OpenCode (openai) upstream', async () => {
  const db = boot(); const hosts: string[] = [];
  const app = buildApp({ db, masterKeyHex: KEY, fetchFn: trackingFetch(hosts) });
  const res = await app.request('/v1/chat/completions', { method: 'POST', headers: H, body: JSON.stringify({ model: 'glm-5.2', messages: [] }) });
  expect(res.status).toBe(200);
  expect(hosts).toEqual(['oc.test']); // never glm.test
});

test('/v1/chat/completions deepseek-v4 routes to an OpenCode upstream', async () => {
  const db = boot(); const hosts: string[] = [];
  const app = buildApp({ db, masterKeyHex: KEY, fetchFn: trackingFetch(hosts) });
  const res = await app.request('/v1/chat/completions', { method: 'POST', headers: H, body: JSON.stringify({ model: 'deepseek-v4', messages: [] }) });
  expect(res.status).toBe(200);
  expect(hosts).toEqual(['oc.test']);
});
