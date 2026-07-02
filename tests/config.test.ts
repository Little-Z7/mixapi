import { test, expect } from 'bun:test';
import { openDb, applySchema } from '../src/data/db';
import { importAccounts, loadConfig, type MixConfig } from '../src/config/load';
import { listCandidates } from '../src/core/pool';
import { StaticKeyCredential } from '../src/credentials/static-key';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KEY = 'a'.repeat(64);
const CFG: MixConfig = {
  accounts: [
    { name: 'glm-1', provider: 'glm', adapter: 'anthropic', baseUrl: 'https://api.z.ai/api/anthropic', keyEnv: 'GLM_1', models: [{ public: 'glm-5.2', target: 'glm-5.2' }] },
    { name: 'oc-1', provider: 'opencode', adapter: 'openai', baseUrl: 'https://opencode.ai/zen/go/v1', keyEnv: 'OC_1', models: [{ public: 'deepseek-v4', target: 'deepseek-v4' }] },
  ],
};

test('imports accounts and stores keys encrypted', async () => {
  const db = openDb(':memory:'); applySchema(db);
  const env = { GLM_1: 'sk-glm', OC_1: 'sk-oc' };
  const r = importAccounts(db, CFG, KEY, env);
  expect(r.imported.sort()).toEqual(['glm-1', 'oc-1']);
  const glm = listCandidates(db, 'glm-5.2')[0];
  expect(glm.adapter).toBe('anthropic');
  expect(await new StaticKeyCredential(glm.secretEnc, KEY).getApiKey()).toBe('sk-glm'); // encrypted round-trip
});

test('idempotent by name — second import skips', () => {
  const db = openDb(':memory:'); applySchema(db);
  const env = { GLM_1: 'sk-glm', OC_1: 'sk-oc' };
  importAccounts(db, CFG, KEY, env);
  const r2 = importAccounts(db, CFG, KEY, env);
  expect(r2.imported).toEqual([]);
  expect(r2.skipped.sort()).toEqual(['glm-1', 'oc-1']);
  expect(db.query('SELECT COUNT(*) AS n FROM accounts').get()).toEqual({ n: 2 });
});

test('missing keyEnv throws', () => {
  const db = openDb(':memory:'); applySchema(db);
  expect(() => importAccounts(db, CFG, KEY, { GLM_1: 'sk-glm' })).toThrow(/OC_1/);
});

test('loadConfig parses a json file', () => {
  const p = join(tmpdir(), `mixcfg-${KEY.slice(0,8)}.json`);
  writeFileSync(p, JSON.stringify(CFG));
  expect(loadConfig(p).accounts.length).toBe(2);
});
