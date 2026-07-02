# mixapi Phase 1B-②′ — GLM coding + OpenCode Go Pooling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pool GLM coding plan (Anthropic-native) and OpenCode Go (OpenAI-native) via same-protocol passthrough — a `config.json` bootstrap declares the multi-account pool, a passthrough `anthropic` adapter + a new Anthropic `/v1/messages` inbound serve GLM coding, OpenCode Go rides the existing `openai` adapter, and a protocol filter keeps the two pipelines from crossing.

**Architecture:** Two protocol-native ingress endpoints (`/v1/chat/completions` OpenAI, `/v1/messages` Anthropic) share the protocol-agnostic pooling core (`routeAndCall`, 1B-①). No OpenAI⇄Anthropic translation — each inbound routes only to same-protocol accounts (via an `adapter` filter on candidate selection) and passes bodies/streams through. `config.json` (dep-free JSON, keys via `keyEnv`) imports accounts into the DB on startup (idempotent by name).

**Tech Stack:** TypeScript · Bun (`bun test`, `bun:sqlite`) · Hono. Builds on `main` @ `4baf616` (1A + 1B-①).

## Global Constraints

- Runtime **Bun**; tests run with `bun test`; DB driver **`bun:sqlite`**.
- **Same-protocol passthrough — NO OpenAI⇄Anthropic translation.** Anthropic inbound → anthropic accounts; OpenAI inbound → openai accounts.
- **Protocol filter is mandatory**: candidate selection filters by the inbound's adapter, because a model (e.g. `glm-5.2`) can live in BOTH pools — the inbound protocol disambiguates.
- **No schema change** — `accounts.adapter ∈ {'openai','anthropic'}`, declared via config.
- **Config**: `config.json` (not YAML); secrets referenced by `keyEnv` (env var name), never stored in the config file; `config.json` is gitignored. DB is the runtime authority; config import is idempotent by account `name`.
- **Never log secrets/tokens**; `secretEnc` never leaves the pool/failover layer.
- Upstream via **injectable `fetchFn`**; selection via **injectable `rng`**; tests never hit the network.
- Anthropic responses/errors use Anthropic shape (`{ type:'error', error:{ type, message } }`); Anthropic usage is `input_tokens`/`output_tokens`.
- Timestamps `Date.now()`; ids `crypto.randomUUID()`. Follow **TDD**; frequent commits.

---

### Task 1: Config loader (`config/load.ts`)  — enables 2a

**Files:**
- Create: `src/config/load.ts`
- Create: `config.example.json`
- Modify: `.gitignore` (append `config.json`)
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: `insertAccount` (1A `src/data/accounts.ts`), `encryptSecret` (1A `src/credentials/crypto.ts`), `listCandidates` (1B-① `src/core/pool.ts`, in test).
- Produces:
  - `interface AccountConfig { name; provider; adapter; baseUrl; keyEnv; models: {public;target}[]; weight? }`
  - `interface MixConfig { accounts: AccountConfig[] }`
  - `loadConfig(path: string): MixConfig`
  - `importAccounts(db: Database, cfg: MixConfig, masterKeyHex: string, env?: Record<string,string|undefined>): { imported: string[]; skipped: string[] }`

- [ ] **Step 1: Write the failing test**

`tests/config.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/config.test.ts`
Expected: FAIL — module `../src/config/load` not found.

- [ ] **Step 3: Write the implementation**

`src/config/load.ts`:
```ts
import { readFileSync } from 'node:fs';
import type { Database } from 'bun:sqlite';
import { insertAccount } from '../data/accounts';
import { encryptSecret } from '../credentials/crypto';

export interface AccountConfig {
  name: string; provider: string; adapter: string; baseUrl: string;
  keyEnv: string; models: { public: string; target: string }[]; weight?: number;
}
export interface MixConfig { accounts: AccountConfig[]; }

export function loadConfig(path: string): MixConfig {
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as MixConfig;
  if (!Array.isArray(cfg.accounts)) throw new Error('config: "accounts" must be an array');
  return cfg;
}

export function importAccounts(
  db: Database, cfg: MixConfig, masterKeyHex: string,
  env: Record<string, string | undefined> = process.env
): { imported: string[]; skipped: string[] } {
  const imported: string[] = [];
  const skipped: string[] = [];
  for (const a of cfg.accounts) {
    if (db.query('SELECT id FROM accounts WHERE name = ?').get(a.name)) { skipped.push(a.name); continue; }
    const key = env[a.keyEnv];
    if (!key) throw new Error(`config: env ${a.keyEnv} is not set for account ${a.name}`);
    insertAccount(db, {
      name: a.name, provider: a.provider, adapter: a.adapter, baseUrl: a.baseUrl,
      models: a.models, weight: a.weight ?? 1, egress: null,
      secretEnc: encryptSecret(key, masterKeyHex),
    });
    imported.push(a.name);
  }
  return { imported, skipped };
}
```

`config.example.json`:
```json
{
  "accounts": [
    { "name": "glm-1", "provider": "glm", "adapter": "anthropic", "baseUrl": "https://api.z.ai/api/anthropic", "keyEnv": "GLM_KEY_1", "models": [{ "public": "glm-5.2", "target": "glm-5.2" }] },
    { "name": "glm-2", "provider": "glm", "adapter": "anthropic", "baseUrl": "https://api.z.ai/api/anthropic", "keyEnv": "GLM_KEY_2", "models": [{ "public": "glm-5.2", "target": "glm-5.2" }] },
    { "name": "opencode-1", "provider": "opencode", "adapter": "openai", "baseUrl": "https://opencode.ai/zen/go/v1", "keyEnv": "OPENCODE_KEY_1", "models": [{ "public": "deepseek-v4", "target": "deepseek-v4" }, { "public": "glm-5.2", "target": "glm-5.2" }] }
  ]
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/config.test.ts` → 4 pass. Then `bun test` → whole suite green.

- [ ] **Step 5: Commit**

```bash
git add src/config/load.ts config.example.json .gitignore tests/config.test.ts
git commit -m "feat: config.json loader (idempotent account import)"
```

---

### Task 2: Protocol filter on candidate selection

**Files:**
- Modify: `src/core/pool.ts` (add optional `adapter` filter param to `listCandidates`)
- Modify: `src/core/failover.ts` (thread `opts.adapter` into `listCandidates`; add `adapter?` to `RouteOpts`)
- Modify: `src/ingress/openai-routes.ts` (pass `adapter: 'openai'` to `routeAndCall`)
- Test: `tests/pool.test.ts` (append a filter test)

**Interfaces:**
- Produces: `listCandidates(db, publicModel, now?, adapter?)` (4th positional param, optional — backward compatible); `RouteOpts` gains `adapter?: string`.

- [ ] **Step 1: Write the failing test (append to `tests/pool.test.ts`)**

```ts
test('adapter filter selects only same-protocol accounts', () => {
  const db = db2();
  const a = add(db, 'oa', 'glm-5.2'); // add() defaults adapter 'openai'
  db.query("UPDATE accounts SET adapter='anthropic' WHERE id=?").run(add(db, 'an', 'glm-5.2'));
  expect(listCandidates(db, 'glm-5.2').length).toBe(2);            // no filter → both
  expect(listCandidates(db, 'glm-5.2', Date.now(), 'anthropic').map(c => c.name)).toEqual(['an']);
  expect(listCandidates(db, 'glm-5.2', Date.now(), 'openai').map(c => c.name)).toEqual(['oa']);
});
```
(Reuses the existing `db2()`/`add()` helpers at the top of `tests/pool.test.ts`; `add()` inserts with `adapter:'openai'`.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/pool.test.ts`
Expected: FAIL — `listCandidates` ignores the 4th arg, returns both for the `'anthropic'` call.

- [ ] **Step 3: Implement**

In `src/core/pool.ts`, change the signature and SQL:
```ts
export function listCandidates(db: Database, publicModel: string, now: number = Date.now(), adapter?: string): Candidate[] {
  const rows = db.query(
    `SELECT a.id,a.name,a.provider,a.adapter,a.base_url,a.models,a.weight,a.egress,
            c.secret_enc AS secret_enc, s.status AS status
     FROM accounts a
     JOIN credentials c ON c.account_id = a.id
     LEFT JOIN account_state s ON s.account_id = a.id
     WHERE a.enabled = 1
       AND COALESCE(s.status, 'unknown') != 'disabled'
       AND (s.cooldown_until IS NULL OR s.cooldown_until <= ?)
       AND (? IS NULL OR a.adapter = ?)`
  ).all(now, adapter ?? null, adapter ?? null) as Row[];
  return rows
    .map((r) => ({
      id: r.id, name: r.name, provider: r.provider, adapter: r.adapter,
      baseUrl: r.base_url, models: JSON.parse(r.models) as ModelMap[],
      weight: r.weight, egress: r.egress, secretEnc: r.secret_enc, status: r.status ?? 'unknown',
    }))
    .filter((c) => c.models.some((m) => m.public === publicModel));
}
```

In `src/core/failover.ts`: add `adapter?: string;` to the `RouteOpts` interface, and change the candidate query line:
```ts
  const candidates = listCandidates(db, req.model, Date.now(), opts.adapter);
```

In `src/ingress/openai-routes.ts`: change the `routeAndCall` call to include the adapter:
```ts
    const outcome = await routeAndCall(db, chatReq, masterKeyHex, { fetchFn, sessionId, adapter: 'openai' });
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/pool.test.ts` → filter test passes. Then `bun test` → whole suite green (existing chat/failover tests unaffected: with only openai accounts, the `'openai'` filter is a no-op that still matches them). `bunx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/pool.ts src/core/failover.ts src/ingress/openai-routes.ts tests/pool.test.ts
git commit -m "feat: protocol (adapter) filter on candidate selection"
```

---

### Task 3: Anthropic passthrough adapter + registry refactor

**Files:**
- Create: `src/adapters/anthropic.ts`
- Modify: `src/adapters/registry.ts` (own the `REGISTRY` map; register `openai` + `anthropic`)
- Modify: `src/adapters/openai.ts` (remove `REGISTRY`/`getAdapter`; export only `openaiAdapter`)
- Modify: `tests/adapter-openai.test.ts` (import `getAdapter` from `../src/adapters/registry` instead of `../src/adapters/openai`)
- Test: `tests/adapter-anthropic.test.ts`

**Interfaces:**
- Consumes: `ProviderAdapter`, `ChatRequest`, `ChatResponse`, `UpstreamRequest`, `ErrorClassification`, `mapModel`, `joinPath` (1A `src/adapters/types.ts`); `ResolvedAccount` (1A).
- Produces: `anthropicAdapter: ProviderAdapter`; `getAdapter(name)` now lives in `registry.ts` and resolves `openai` + `anthropic`.

- [ ] **Step 1: Write the failing test**

`tests/adapter-anthropic.test.ts`:
```ts
import { test, expect } from 'bun:test';
import { anthropicAdapter } from '../src/adapters/anthropic';
import { getAdapter } from '../src/adapters/registry';
import type { ChatRequest } from '../src/adapters/types';
import type { ResolvedAccount } from '../src/data/accounts';

const account: ResolvedAccount = {
  id: 'a1', name: 'glm', provider: 'glm', adapter: 'anthropic',
  baseUrl: 'https://api.z.ai/api/anthropic', models: [{ public: 'glm-5.2', target: 'glm-real' }],
  weight: 1, egress: null,
};
const req = { model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }], stream: false } as unknown as ChatRequest;

test('buildRequest hits /v1/messages with both auth headers and renamed model', () => {
  const u = anthropicAdapter.buildRequest(req, account, 'sk-tok');
  expect(u.url).toBe('https://api.z.ai/api/anthropic/v1/messages');
  expect(u.headers['x-api-key']).toBe('sk-tok');
  expect(u.headers.authorization).toBe('Bearer sk-tok');
  expect(u.headers['anthropic-version']).toBeTruthy();
  expect(JSON.parse(u.body).model).toBe('glm-real');
});

test('classifyError maps Anthropic statuses', () => {
  expect(anthropicAdapter.classifyError(429, {}, new Headers({ 'retry-after': '7' }))).toEqual({ retryable: true, reason: 'rate_limit', cooldownMs: 7000 });
  expect(anthropicAdapter.classifyError(429, {}, new Headers({ 'retry-after': 'Wed, 21 Oct 2099 07:28:00 GMT' })).cooldownMs).toBe(30000); // NaN guard → default
  expect(anthropicAdapter.classifyError(401, {}, new Headers()).reason).toBe('auth');
  expect(anthropicAdapter.classifyError(400, {}, new Headers())).toEqual({ retryable: false, reason: 'bad_request' });
  expect(anthropicAdapter.classifyError(529, {}, new Headers()).reason).toBe('server');
});

test('parseResponse and translateStreamChunk pass through', () => {
  expect(anthropicAdapter.parseResponse(200, { content: [{ text: 'hi' }] })).toEqual({ content: [{ text: 'hi' }] });
  expect(anthropicAdapter.translateStreamChunk('{"x":1}')).toEqual(['{"x":1}']);
});

test('registry resolves both adapters, throws on unknown', () => {
  expect(getAdapter('anthropic').name).toBe('anthropic');
  expect(getAdapter('openai').name).toBe('openai');
  expect(() => getAdapter('nope')).toThrow();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/adapter-anthropic.test.ts`
Expected: FAIL — module `../src/adapters/anthropic` not found.

- [ ] **Step 3: Implement**

`src/adapters/anthropic.ts`:
```ts
import type { ProviderAdapter, ChatRequest, ChatResponse, UpstreamRequest, ErrorClassification } from './types';
import { mapModel, joinPath } from './types';
import type { ResolvedAccount } from '../data/accounts';

export const anthropicAdapter: ProviderAdapter = {
  name: 'anthropic',
  buildRequest(req: ChatRequest, account: ResolvedAccount, apiKey: string): UpstreamRequest {
    const body = { ...req, model: mapModel(req.model, account) };
    return {
      url: joinPath(account.baseUrl, '/v1/messages'),
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        authorization: `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    };
  },
  parseResponse(_status: number, body: unknown): ChatResponse {
    return (body ?? {}) as ChatResponse;
  },
  translateStreamChunk(rawData: string): string[] {
    return [rawData];
  },
  classifyError(status: number, _body: unknown, headers: Headers): ErrorClassification {
    if (status === 429) {
      const ra = Number(headers.get('retry-after'));
      return { retryable: true, reason: 'rate_limit', cooldownMs: Number.isFinite(ra) ? ra * 1000 : 30000 };
    }
    if (status === 401 || status === 403) return { retryable: true, reason: 'auth' };
    if (status === 400) return { retryable: false, reason: 'bad_request' };
    if (status === 529 || status >= 500) return { retryable: true, reason: 'server', cooldownMs: 5000 };
    return { retryable: status >= 400, reason: 'unknown' };
  },
};
```

`src/adapters/registry.ts` (replace the one-line re-export with the owning map):
```ts
import type { ProviderAdapter } from './types';
import { openaiAdapter } from './openai';
import { anthropicAdapter } from './anthropic';

const REGISTRY: Record<string, ProviderAdapter> = {
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
};

export function getAdapter(name: string): ProviderAdapter {
  const a = REGISTRY[name];
  if (!a) throw new Error(`unknown adapter: ${name}`);
  return a;
}
```

In `src/adapters/openai.ts`, remove the `REGISTRY` const and the `getAdapter` export (delete those lines), keeping only `openaiAdapter` (and its imports). The file must no longer declare `REGISTRY` or `getAdapter`.

In `tests/adapter-openai.test.ts`, change the import line:
```ts
import { openaiAdapter } from '../src/adapters/openai';
import { getAdapter } from '../src/adapters/registry';
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/adapter-anthropic.test.ts tests/adapter-openai.test.ts` → green. Then `bun test` (whole suite — `failover.ts`/`openai-routes.ts` import `getAdapter` from `../adapters/registry`, which still exports it, so no breakage). `bunx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/anthropic.ts src/adapters/registry.ts src/adapters/openai.ts tests/adapter-anthropic.test.ts tests/adapter-openai.test.ts
git commit -m "feat: anthropic passthrough adapter + registry owns adapter map"
```

---

### Task 4: Anthropic `/v1/messages` inbound + shared auth

**Files:**
- Create: `src/ingress/anthropic-routes.ts`
- Modify: `src/server.ts` (move the `/v1/*` auth middleware into `buildApp`; register both route sets)
- Modify: `src/ingress/openai-routes.ts` (remove its own `app.use('/v1/*')` middleware — now in `buildApp`)
- Test: `tests/messages.test.ts`

**Interfaces:**
- Consumes: `routeAndCall`/`RouteOutcome` + `RouteDeps` (from `openai-routes.ts`), `getAdapter` (registry), `verifyGatewayKey` (auth), `logRequest` (usage), `ChatRequest`.
- Produces: `registerAnthropicRoutes(app: Hono, deps: RouteDeps): void` mounting `POST /v1/messages`.

- [ ] **Step 1: Write the failing test**

`tests/messages.test.ts`:
```ts
import { test, expect } from 'bun:test';
import { openDb, applySchema } from '../src/data/db';
import { insertAccount } from '../src/data/accounts';
import { encryptSecret } from '../src/credentials/crypto';
import { seedGatewayKey } from '../src/ingress/auth';
import { buildApp } from '../src/server';

const KEY = 'a'.repeat(64);
function addAcct(db: any, name: string, adapter: string, model: string) {
  insertAccount(db, {
    name, provider: 'p', adapter, baseUrl: 'https://up.test',
    models: [{ public: model, target: model }], weight: 1, egress: null,
    secretEnc: encryptSecret('sk', KEY),
  });
}
function setup() {
  const db = openDb(':memory:'); applySchema(db); seedGatewayKey(db, 'gw');
  return db;
}

test('401 without gateway key', async () => {
  const db = setup();
  const app = buildApp({ db, masterKeyHex: KEY, fetchFn: (async () => new Response('{}')) as any });
  const res = await app.request('/v1/messages', { method: 'POST', body: '{}' });
  expect(res.status).toBe(401);
});

test('pools anthropic accounts and fails over (Anthropic passthrough)', async () => {
  const db = setup();
  addAcct(db, 'glm-a', 'anthropic', 'glm-5.2');
  addAcct(db, 'glm-b', 'anthropic', 'glm-5.2');
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    return calls === 1
      ? new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }), { status: 429 })
      : new Response(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'hi' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const app = buildApp({ db, masterKeyHex: KEY, fetchFn });
  const res = await app.request('/v1/messages', {
    method: 'POST', headers: { authorization: 'Bearer gw', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.2', stream: false, messages: [{ role: 'user', content: [{ type: 'text', text: 'hey' }] }] }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).content[0].text).toBe('hi'); // Anthropic-shaped passthrough
  const log = db.query('SELECT attempt_count FROM request_logs ORDER BY ts DESC LIMIT 1').get() as any;
  expect(log.attempt_count).toBe(2);
});

test('protocol isolation: /v1/messages never routes to an openai account for a shared model', async () => {
  const db = setup();
  addAcct(db, 'oc-openai', 'openai', 'glm-5.2'); // same model, wrong protocol
  const app = buildApp({ db, masterKeyHex: KEY, fetchFn: (async () => new Response('{}')) as any });
  const res = await app.request('/v1/messages', {
    method: 'POST', headers: { authorization: 'Bearer gw', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.2', messages: [] }),
  });
  expect(res.status).toBe(404); // no anthropic candidate → not_found (never picks the openai account)
  expect((await res.json()).type).toBe('error');
});

test('malformed JSON -> 400 anthropic-shaped', async () => {
  const db = setup();
  const app = buildApp({ db, masterKeyHex: KEY, fetchFn: (async () => new Response('{}')) as any });
  const res = await app.request('/v1/messages', {
    method: 'POST', headers: { authorization: 'Bearer gw', 'content-type': 'application/json' }, body: 'not json{',
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error.type).toBe('invalid_request_error');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/messages.test.ts`
Expected: FAIL — `/v1/messages` route doesn't exist (404 on the 401 test, or route-not-found).

- [ ] **Step 3: Move the shared auth middleware into `buildApp`**

Replace `src/server.ts` with:
```ts
import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import { verifyGatewayKey } from './ingress/auth';
import { registerOpenAIRoutes } from './ingress/openai-routes';
import { registerAnthropicRoutes } from './ingress/anthropic-routes';

export interface AppDeps { db: Database; masterKeyHex: string; fetchFn?: typeof fetch; }

export function buildApp(deps?: AppDeps): Hono {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  if (deps) {
    app.use('/v1/*', async (c, next) => {
      if (!verifyGatewayKey(deps.db, c.req.header('authorization'))) {
        return c.json({ error: { message: 'invalid gateway key', type: 'auth' } }, 401);
      }
      await next();
    });
    registerOpenAIRoutes(app, deps);
    registerAnthropicRoutes(app, deps);
  }
  return app;
}
```

In `src/ingress/openai-routes.ts`, DELETE the `app.use('/v1/*', ...)` middleware block from `registerOpenAIRoutes` (the middleware now lives in `buildApp`). Keep the `import { verifyGatewayKey }` line ONLY if still referenced — it is not after this deletion, so remove that import too. Everything else in the file (the `/v1/models` and `/v1/chat/completions` handlers, incl. the `adapter:'openai'` from Task 2) stays.

- [ ] **Step 4: Write the Anthropic route**

`src/ingress/anthropic-routes.ts`:
```ts
import { Hono } from 'hono';
import { routeAndCall } from '../core/failover';
import { getAdapter } from '../adapters/registry';
import { logRequest } from '../usage';
import type { ChatRequest } from '../adapters/types';
import type { RouteDeps } from './openai-routes';

function anthropicError(type: string, message: string) {
  return { type: 'error', error: { type, message } };
}

export function registerAnthropicRoutes(app: Hono, deps: RouteDeps): void {
  const { db, masterKeyHex } = deps;
  const fetchFn = deps.fetchFn ?? fetch;

  app.post('/v1/messages', async (c) => {
    const started = Date.now();
    let body: any;
    try { body = await c.req.json(); }
    catch { return c.json(anthropicError('invalid_request_error', 'invalid JSON body'), 400); }
    if (!body?.model) return c.json(anthropicError('invalid_request_error', 'model required'), 400);
    const stream = body.stream === true;
    const req = { ...body, model: body.model, stream } as ChatRequest;
    const sessionId = c.req.header('x-session-id');

    const outcome = await routeAndCall(db, req, masterKeyHex, { fetchFn, sessionId, adapter: 'anthropic' });

    if (outcome.noCandidates) {
      logRequest(db, { publicModel: body.model, status: 'error', httpStatus: 404, stream, attemptCount: 0 });
      return c.json(anthropicError('not_found_error', `no account serves model ${body.model}`), 404);
    }
    if (!outcome.ok || !outcome.result) {
      const httpStatus = outcome.lastError?.httpStatus ?? 502;
      logRequest(db, { publicModel: body.model, accountId: outcome.account?.id ?? null, status: 'error', httpStatus, latencyMs: Date.now() - started, stream, attemptCount: outcome.attempts });
      return c.json(anthropicError('api_error', 'upstream error'), httpStatus as any);
    }

    const result = outcome.result;
    const account = outcome.account!;

    if (stream && result.stream) {
      logRequest(db, { publicModel: body.model, accountId: account.id, status: 'ok', httpStatus: 200, latencyMs: Date.now() - started, stream: true, attemptCount: outcome.attempts });
      return new Response(result.stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } });
    }
    if (stream && !result.stream) {
      logRequest(db, { publicModel: body.model, accountId: account.id, status: 'error', httpStatus: 502, latencyMs: Date.now() - started, stream, attemptCount: outcome.attempts });
      return c.json(anthropicError('api_error', 'upstream returned no stream body'), 502);
    }

    const parsed = getAdapter(account.adapter).parseResponse(result.status, result.json) as any;
    const usage = parsed?.usage ?? {};
    const inTok = usage.input_tokens ?? null, outTok = usage.output_tokens ?? null;
    logRequest(db, {
      publicModel: body.model, accountId: account.id, status: 'ok', httpStatus: result.status,
      latencyMs: Date.now() - started, promptTokens: inTok, completionTokens: outTok,
      totalTokens: inTok != null || outTok != null ? (inTok ?? 0) + (outTok ?? 0) : null,
      estCost: 0, attemptCount: outcome.attempts, stream: false,
    });
    return c.json(parsed, result.status as any);
  });
}
```

- [ ] **Step 5: Run + commit**

Run: `bun test tests/messages.test.ts` → 4 pass. Then `bun test` (existing chat tests still pass — the 401 middleware now lives in `buildApp` and still covers `/v1/chat/completions`). `bunx tsc --noEmit` → clean.

```bash
git add src/ingress/anthropic-routes.ts src/server.ts src/ingress/openai-routes.ts tests/messages.test.ts
git commit -m "feat: Anthropic /v1/messages inbound (passthrough) + shared gateway-key middleware"
```

---

### Task 5: Acceptance — dual-provider pool + protocol isolation

**Files:**
- Test: `tests/acceptance.test.ts`
- Modify: `src/index.ts` (load `config.json` if present at startup — wire `loadConfig`/`importAccounts`)

**Interfaces:**
- Consumes: everything above. No new production interfaces.

- [ ] **Step 1: Write the acceptance test**

`tests/acceptance.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/acceptance.test.ts`
Expected: PASS actually — all pieces exist by Task 4. If it fails, the failure localizes the gap. (This task is the end-to-end safety net; if green immediately, that's the acceptance signal. Still add the `index.ts` wiring below and keep the test.)

- [ ] **Step 3: Wire config load into the entrypoint**

In `src/index.ts`, after `applySchema(db)` and before `buildApp`, load the config if a `config.json` exists:
```ts
import { existsSync } from 'node:fs';
import { loadConfig, importAccounts } from './config/load';
// ...after applySchema(db) and the GATEWAY_KEY seed:
const cfgPath = process.env.CONFIG_PATH ?? './config.json';
if (existsSync(cfgPath)) {
  const { imported, skipped } = importAccounts(db, loadConfig(cfgPath), masterKeyHex);
  console.log(`config: imported ${imported.length} account(s), skipped ${skipped.length}`);
}
```
(Keep the existing `MASTER_KEY`/`DB_PATH`/`GATEWAY_KEY` wiring; only add the config import. `console.log` here logs counts only — no secrets.)

- [ ] **Step 4: Run the full suite**

Run: `bun test` → all suites green (config, adapter-anthropic, pool filter, messages, acceptance, plus all prior). Run `bunx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add tests/acceptance.test.ts src/index.ts
git commit -m "feat: config-driven startup + dual-provider protocol-isolation acceptance"
```

---

## Phase 1B-②′ Definition of Done

- `bun test` green; `bunx tsc --noEmit` clean.
- `config.json` declares the pool; startup imports it idempotently (by name); keys stored encrypted; no secret logged.
- **OpenCode Go**: multiple Go keys pool behind `/v1/chat/completions` with failover (`attempt_count` reflects retries).
- **GLM coding**: multiple GLM keys pool behind `/v1/messages` (Anthropic-native passthrough) with failover; responses/streams/errors are Anthropic-shaped.
- **Protocol isolation**: for `glm-5.2` (present in both pools), `/v1/messages` routes only to anthropic accounts and `/v1/chat/completions` only to openai accounts (verified by which upstream host is hit).

## Deferred (next slices)
Cross-protocol translation (OpenAI⇄Anthropic, any client × any provider); admin REST/console (Phase 3); session/OAuth pooling (Phase 2); config hot-reload / updating existing accounts (currently first-run import of missing accounts only); plus the still-open cheap `health.ts` polish items (literal-union `status`, exhaustive `switch`) and the explicit `req.stream &&` guard on the failover anomaly branch — fold in when those files are next touched. Tracked in `.superpowers/sdd/progress.md`.
