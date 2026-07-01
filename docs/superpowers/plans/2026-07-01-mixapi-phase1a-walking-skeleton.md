# mixapi Phase 1A — Walking Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a working OpenAI-compatible gateway that proxies `/v1/chat/completions` (streaming + non-streaming) to a **single** key-based upstream account loaded from SQLite, with encrypted credentials, gateway-key auth, and request logging.

**Architecture:** A Hono app on Bun. Requests are authenticated by a hashed gateway key, parsed into a canonical `ChatRequest`, routed to one enabled account via a trivial single-account selector, translated to the upstream by a `ProviderAdapter` (only `openai` in 1A), sent with an injectable `fetch`, and streamed/returned back in OpenAI shape while a row is written to `request_logs`. Credentials are stored AES-256-GCM encrypted; nothing secret is ever logged. This is the vertical slice that de-risks boot → DB → crypto → adapter → streaming → ingress before pooling is added in Phase 1B.

**Tech Stack:** TypeScript, Bun (runtime + `bun test` + `bun:sqlite`), Hono (HTTP + SSE), Node `crypto` (AES-256-GCM, SHA-256). No ORM in 1A — a thin typed SQL layer over `bun:sqlite` (keeps deps and migration tooling out of the MVP; Drizzle can be adopted later if queries grow).

## Global Constraints

- Runtime is **Bun**; all tests run with `bun test`; DB driver is built-in **`bun:sqlite`**.
- HTTP framework is **Hono**; upstream calls use the Fetch API with an **injectable `fetchFn`** so tests never hit the network.
- Credentials (`credentials.secret_enc`) are stored **AES-256-GCM** encrypted; `MASTER_KEY` env var is **64 hex chars (32 bytes)**.
- Gateway/admin keys are stored **SHA-256 hashed**, never in plaintext.
- **Never log secrets or tokens** — no API keys, no Authorization headers in any log line.
- Public surface is **OpenAI-compatible**: `POST /v1/chat/completions`, `GET /v1/models`.
- **DB is the runtime authority.** (config.yaml bootstrap is Phase 1B.)
- Follow **TDD**: write the failing test first, watch it fail, implement minimally, watch it pass, commit. Frequent small commits.
- Timestamps are `Date.now()` (integer ms); ids are `crypto.randomUUID()`.

---

### Task 1: Project scaffold + `/healthz`

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.env.example`
- Create: `src/server.ts`
- Create: `src/index.ts`
- Create: `tests/server.test.ts`
- Modify: `.gitignore` (append `node_modules`, `.env`, `*.sqlite`, `*.sqlite-shm`, `*.sqlite-wal`)

**Interfaces:**
- Produces: `buildApp(deps: AppDeps): Hono` where `AppDeps = { db: Database; masterKeyHex: string; fetchFn?: typeof fetch }`. In Task 1 `buildApp` takes **no** deps yet (added in Task 10); for now export `buildApp(): Hono` and widen the signature in Task 10.

- [ ] **Step 1: Write the failing test**

`tests/server.test.ts`:
```ts
import { test, expect } from 'bun:test';
import { buildApp } from '../src/server';

test('GET /healthz returns ok', async () => {
  const app = buildApp();
  const res = await app.request('/healthz');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: 'ok' });
});
```

- [ ] **Step 2: Create project files**

`package.json`:
```json
{
  "name": "mixapi",
  "type": "module",
  "scripts": {
    "dev": "bun run src/index.ts",
    "test": "bun test"
  },
  "dependencies": {
    "hono": "^4.6.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "@types/bun": "^1.1.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  }
}
```

`.env.example`:
```
# 64 hex chars = 32 bytes for AES-256-GCM
MASTER_KEY=
# bootstrap gateway key clients use as: Authorization: Bearer <this>
GATEWAY_KEY=
PORT=8080
DB_PATH=./mixapi.sqlite
```

- [ ] **Step 3: Write minimal implementation**

`src/server.ts`:
```ts
import { Hono } from 'hono';

export function buildApp(): Hono {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  return app;
}
```

`src/index.ts`:
```ts
import { buildApp } from './server';

const app = buildApp();
const port = Number(process.env.PORT ?? 8080);
export default { port, fetch: app.fetch };
```

- [ ] **Step 4: Install deps, run test**

Run: `bun install && bun test tests/server.test.ts`
Expected: 1 pass.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json .env.example .gitignore src/server.ts src/index.ts tests/server.test.ts
git commit -m "feat: scaffold Bun+Hono app with /healthz"
```

---

### Task 2: SQLite schema + typed account repo

**Files:**
- Create: `src/data/db.ts`
- Create: `src/data/schema.ts`
- Create: `src/data/accounts.ts`
- Create: `tests/data.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `openDb(path: string): Database` (from `bun:sqlite`)
  - `applySchema(db: Database): void`
  - Types: `ModelMap = { public: string; target: string }`, `ResolvedAccount = { id: string; name: string; provider: string; adapter: string; baseUrl: string; models: ModelMap[]; weight: number; egress: string | null }`, `NewAccount = Omit<ResolvedAccount,'id'> & { secretEnc: Uint8Array; credType?: string }`
  - `insertAccount(db: Database, a: NewAccount): string` (returns account id; also seeds an `account_state` row with status `'unknown'`)
  - `listEnabledAccountsForModel(db: Database, publicModel: string): (ResolvedAccount & { secretEnc: Uint8Array })[]`
  - `listPublicModels(db: Database): string[]`

- [ ] **Step 1: Write the failing test**

`tests/data.test.ts`:
```ts
import { test, expect } from 'bun:test';
import { openDb, applySchema } from '../src/data/db';
import { insertAccount, listEnabledAccountsForModel, listPublicModels } from '../src/data/accounts';

function freshDb() {
  const db = openDb(':memory:');
  applySchema(db);
  return db;
}

test('insert + list account by public model', () => {
  const db = freshDb();
  const id = insertAccount(db, {
    name: 'glm-1', provider: 'glm', adapter: 'openai',
    baseUrl: 'https://example.test/v1',
    models: [{ public: 'glm-4.6', target: 'glm-4.6' }],
    weight: 1, egress: null, secretEnc: new Uint8Array([1, 2, 3]),
  });
  expect(id).toBeTruthy();

  const rows = listEnabledAccountsForModel(db, 'glm-4.6');
  expect(rows.length).toBe(1);
  expect(rows[0].name).toBe('glm-1');
  expect(rows[0].models[0].target).toBe('glm-4.6');
  expect(Array.from(rows[0].secretEnc)).toEqual([1, 2, 3]);

  expect(listEnabledAccountsForModel(db, 'nope')).toEqual([]);
  expect(listPublicModels(db)).toEqual(['glm-4.6']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/data.test.ts`
Expected: FAIL — module `../src/data/db` not found.

- [ ] **Step 3: Write minimal implementation**

`src/data/schema.ts`:
```ts
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  adapter TEXT NOT NULL,
  base_url TEXT NOT NULL,
  models TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  egress TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  type TEXT NOT NULL,
  secret_enc BLOB NOT NULL,
  meta TEXT
);
CREATE TABLE IF NOT EXISTS account_state (
  account_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'unknown',
  cooldown_until INTEGER,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  last_error TEXT,
  last_checked_at INTEGER
);
CREATE TABLE IF NOT EXISTS request_logs (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  gateway_key_id TEXT,
  public_model TEXT,
  account_id TEXT,
  status TEXT NOT NULL,
  http_status INTEGER,
  latency_ms INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  est_cost REAL,
  attempt_count INTEGER,
  stream INTEGER,
  client_ip TEXT
);
CREATE TABLE IF NOT EXISTS gateway_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  name TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
`;
```

`src/data/db.ts`:
```ts
import { Database } from 'bun:sqlite';
import { SCHEMA_SQL } from './schema';

export function openDb(path: string): Database {
  const db = new Database(path);
  db.run('PRAGMA journal_mode = WAL;');
  db.run('PRAGMA foreign_keys = ON;');
  return db;
}

export function applySchema(db: Database): void {
  db.run(SCHEMA_SQL);
}

export type { Database };
```

`src/data/accounts.ts`:
```ts
import type { Database } from 'bun:sqlite';

export interface ModelMap { public: string; target: string; }
export interface ResolvedAccount {
  id: string; name: string; provider: string; adapter: string;
  baseUrl: string; models: ModelMap[]; weight: number; egress: string | null;
}
export interface NewAccount {
  name: string; provider: string; adapter: string; baseUrl: string;
  models: ModelMap[]; weight: number; egress: string | null;
  secretEnc: Uint8Array; credType?: string;
}

interface AccountRow {
  id: string; name: string; provider: string; adapter: string;
  base_url: string; models: string; weight: number; egress: string | null;
}

function rowToResolved(r: AccountRow): ResolvedAccount {
  return {
    id: r.id, name: r.name, provider: r.provider, adapter: r.adapter,
    baseUrl: r.base_url, models: JSON.parse(r.models), weight: r.weight, egress: r.egress,
  };
}

export function insertAccount(db: Database, a: NewAccount): string {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.query(
    `INSERT INTO accounts (id,name,provider,adapter,base_url,models,weight,enabled,egress,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,1,?,?,?)`
  ).run(id, a.name, a.provider, a.adapter, a.baseUrl, JSON.stringify(a.models), a.weight, a.egress, now, now);
  db.query(
    `INSERT INTO credentials (id,account_id,type,secret_enc,meta) VALUES (?,?,?,?,NULL)`
  ).run(crypto.randomUUID(), id, a.credType ?? 'static_key', a.secretEnc);
  db.query(
    `INSERT INTO account_state (account_id,status,consecutive_errors) VALUES (?, 'unknown', 0)`
  ).run(id);
  return id;
}

export function listEnabledAccountsForModel(
  db: Database, publicModel: string
): (ResolvedAccount & { secretEnc: Uint8Array })[] {
  const rows = db.query(
    `SELECT a.id,a.name,a.provider,a.adapter,a.base_url,a.models,a.weight,a.egress,
            c.secret_enc AS secret_enc
     FROM accounts a JOIN credentials c ON c.account_id = a.id
     WHERE a.enabled = 1`
  ).all() as (AccountRow & { secret_enc: Uint8Array })[];
  return rows
    .map((r) => ({ ...rowToResolved(r), secretEnc: r.secret_enc }))
    .filter((a) => a.models.some((m) => m.public === publicModel));
}

export function listPublicModels(db: Database): string[] {
  const rows = db.query(`SELECT models FROM accounts WHERE enabled = 1`).all() as { models: string }[];
  const set = new Set<string>();
  for (const r of rows) for (const m of JSON.parse(r.models) as ModelMap[]) set.add(m.public);
  return [...set];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/data.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data/db.ts src/data/schema.ts src/data/accounts.ts tests/data.test.ts
git commit -m "feat: sqlite schema + typed account repo"
```

---

### Task 3: Credential crypto (AES-256-GCM)

**Files:**
- Create: `src/credentials/crypto.ts`
- Create: `tests/crypto.test.ts`

**Interfaces:**
- Produces:
  - `encryptSecret(plaintext: string, masterKeyHex: string): Uint8Array` — layout `iv(12) | tag(16) | ciphertext`
  - `decryptSecret(blob: Uint8Array, masterKeyHex: string): string`

- [ ] **Step 1: Write the failing test**

`tests/crypto.test.ts`:
```ts
import { test, expect } from 'bun:test';
import { encryptSecret, decryptSecret } from '../src/credentials/crypto';

const KEY = 'a'.repeat(64); // 32 bytes hex

test('encrypt/decrypt round-trip', () => {
  const blob = encryptSecret('sk-secret-123', KEY);
  expect(blob.length).toBeGreaterThan(28);
  expect(decryptSecret(blob, KEY)).toBe('sk-secret-123');
});

test('wrong key fails to decrypt', () => {
  const blob = encryptSecret('sk-secret-123', KEY);
  expect(() => decryptSecret(blob, 'b'.repeat(64))).toThrow();
});

test('tampered ciphertext fails', () => {
  const blob = encryptSecret('sk-secret-123', KEY);
  blob[blob.length - 1] ^= 0xff;
  expect(() => decryptSecret(blob, KEY)).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/crypto.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`src/credentials/crypto.ts`:
```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALG = 'aes-256-gcm';

function key(masterKeyHex: string): Buffer {
  const k = Buffer.from(masterKeyHex, 'hex');
  if (k.length !== 32) throw new Error('MASTER_KEY must be 64 hex chars (32 bytes)');
  return k;
}

export function encryptSecret(plaintext: string, masterKeyHex: string): Uint8Array {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, key(masterKeyHex), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return new Uint8Array(Buffer.concat([iv, tag, ct]));
}

export function decryptSecret(blob: Uint8Array, masterKeyHex: string): string {
  const buf = Buffer.from(blob);
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv(ALG, key(masterKeyHex), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/crypto.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add src/credentials/crypto.ts tests/crypto.test.ts
git commit -m "feat: AES-256-GCM credential crypto"
```

---

### Task 4: CredentialSource interface + StaticKey

**Files:**
- Create: `src/credentials/types.ts`
- Create: `src/credentials/static-key.ts`
- Create: `tests/credentials.test.ts`

**Interfaces:**
- Consumes: `decryptSecret` (Task 3).
- Produces:
  - `interface CredentialSource { getApiKey(): Promise<string> }`
  - `class StaticKeyCredential implements CredentialSource` with `constructor(secretEnc: Uint8Array, masterKeyHex: string)`

- [ ] **Step 1: Write the failing test**

`tests/credentials.test.ts`:
```ts
import { test, expect } from 'bun:test';
import { encryptSecret } from '../src/credentials/crypto';
import { StaticKeyCredential } from '../src/credentials/static-key';

const KEY = 'a'.repeat(64);

test('StaticKeyCredential returns decrypted api key', async () => {
  const enc = encryptSecret('sk-upstream-xyz', KEY);
  const cred = new StaticKeyCredential(enc, KEY);
  expect(await cred.getApiKey()).toBe('sk-upstream-xyz');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/credentials.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`src/credentials/types.ts`:
```ts
export interface CredentialSource {
  getApiKey(): Promise<string>;
}
```

`src/credentials/static-key.ts`:
```ts
import type { CredentialSource } from './types';
import { decryptSecret } from './crypto';

export class StaticKeyCredential implements CredentialSource {
  constructor(private secretEnc: Uint8Array, private masterKeyHex: string) {}
  async getApiKey(): Promise<string> {
    return decryptSecret(this.secretEnc, this.masterKeyHex);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/credentials.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/credentials/types.ts src/credentials/static-key.ts tests/credentials.test.ts
git commit -m "feat: CredentialSource + StaticKey"
```

---

### Task 5: Adapter types + OpenAI adapter + registry

**Files:**
- Create: `src/adapters/types.ts`
- Create: `src/adapters/openai.ts`
- Create: `src/adapters/registry.ts`
- Create: `tests/adapter-openai.test.ts`

**Interfaces:**
- Consumes: `ResolvedAccount`, `ModelMap` (Task 2).
- Produces:
  - Types `ChatMessage`, `ChatRequest`, `ChatResponse`, `UpstreamRequest`, `ErrorReason`, `ErrorClassification`, `ProviderAdapter`
  - `mapModel(publicModel: string, account: ResolvedAccount): string`
  - `openaiAdapter: ProviderAdapter`
  - `getAdapter(name: string): ProviderAdapter` (throws on unknown)

```ts
// shapes produced here, referenced by later tasks:
interface ChatRequest { model: string; messages: ChatMessage[]; stream: boolean; [k: string]: unknown }
interface UpstreamRequest { url: string; headers: Record<string,string>; body: string }
type ErrorReason = 'rate_limit'|'quota'|'auth'|'server'|'bad_request'|'unknown';
interface ErrorClassification { retryable: boolean; reason: ErrorReason; cooldownMs?: number }
interface ProviderAdapter {
  name: string;
  buildRequest(req: ChatRequest, account: ResolvedAccount, apiKey: string): UpstreamRequest;
  parseResponse(status: number, body: unknown): ChatResponse;
  translateStreamChunk(rawData: string): string[];
  classifyError(status: number, body: unknown, headers: Headers): ErrorClassification;
}
```

- [ ] **Step 1: Write the failing test**

`tests/adapter-openai.test.ts`:
```ts
import { test, expect } from 'bun:test';
import { openaiAdapter, getAdapter } from '../src/adapters/openai';
import type { ChatRequest } from '../src/adapters/types';
import type { ResolvedAccount } from '../src/data/accounts';

const account: ResolvedAccount = {
  id: 'a1', name: 'glm', provider: 'glm', adapter: 'openai',
  baseUrl: 'https://api.test/v1/', models: [{ public: 'glm-4.6', target: 'glm-real' }],
  weight: 1, egress: null,
};
const req: ChatRequest = { model: 'glm-4.6', messages: [{ role: 'user', content: 'hi' }], stream: false };

test('buildRequest maps model, sets auth + url', () => {
  const u = openaiAdapter.buildRequest(req, account, 'sk-key');
  expect(u.url).toBe('https://api.test/v1/chat/completions');
  expect(u.headers.authorization).toBe('Bearer sk-key');
  const body = JSON.parse(u.body);
  expect(body.model).toBe('glm-real');
  expect(body.messages[0].content).toBe('hi');
});

test('classifyError maps statuses', () => {
  const h = new Headers({ 'retry-after': '12' });
  expect(openaiAdapter.classifyError(429, {}, h)).toEqual({ retryable: true, reason: 'rate_limit', cooldownMs: 12000 });
  expect(openaiAdapter.classifyError(401, {}, new Headers()).reason).toBe('auth');
  expect(openaiAdapter.classifyError(400, {}, new Headers())).toEqual({ retryable: false, reason: 'bad_request' });
  expect(openaiAdapter.classifyError(503, {}, new Headers()).reason).toBe('server');
});

test('translateStreamChunk passes through', () => {
  expect(openaiAdapter.translateStreamChunk('{"x":1}')).toEqual(['{"x":1}']);
});

test('getAdapter throws on unknown', () => {
  expect(getAdapter('openai').name).toBe('openai');
  expect(() => getAdapter('nope')).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/adapter-openai.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`src/adapters/types.ts`:
```ts
import type { ResolvedAccount } from '../data/accounts';

export interface ChatMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; name?: string; }
export interface ChatRequest { model: string; messages: ChatMessage[]; stream: boolean; [k: string]: unknown; }
export interface ChatResponse { [k: string]: unknown; }

export interface UpstreamRequest { url: string; headers: Record<string, string>; body: string; }

export type ErrorReason = 'rate_limit' | 'quota' | 'auth' | 'server' | 'bad_request' | 'unknown';
export interface ErrorClassification { retryable: boolean; reason: ErrorReason; cooldownMs?: number; }

export interface ProviderAdapter {
  name: string;
  buildRequest(req: ChatRequest, account: ResolvedAccount, apiKey: string): UpstreamRequest;
  parseResponse(status: number, body: unknown): ChatResponse;
  translateStreamChunk(rawData: string): string[];
  classifyError(status: number, body: unknown, headers: Headers): ErrorClassification;
}

export function mapModel(publicModel: string, account: ResolvedAccount): string {
  return account.models.find((m) => m.public === publicModel)?.target ?? publicModel;
}

export function joinPath(base: string, path: string): string {
  return base.replace(/\/+$/, '') + path;
}
```

`src/adapters/openai.ts`:
```ts
import type { ProviderAdapter, ChatRequest, ChatResponse, UpstreamRequest, ErrorClassification } from './types';
import { mapModel, joinPath } from './types';
import type { ResolvedAccount } from '../data/accounts';

export const openaiAdapter: ProviderAdapter = {
  name: 'openai',
  buildRequest(req: ChatRequest, account: ResolvedAccount, apiKey: string): UpstreamRequest {
    const body = { ...req, model: mapModel(req.model, account) };
    return {
      url: joinPath(account.baseUrl, '/chat/completions'),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
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
      const ra = headers.get('retry-after');
      return { retryable: true, reason: 'rate_limit', cooldownMs: ra ? Number(ra) * 1000 : 30000 };
    }
    if (status === 401 || status === 403) return { retryable: true, reason: 'auth' };
    if (status === 400) return { retryable: false, reason: 'bad_request' };
    if (status >= 500) return { retryable: true, reason: 'server', cooldownMs: 5000 };
    return { retryable: status >= 400, reason: 'unknown' };
  },
};

const REGISTRY: Record<string, ProviderAdapter> = { openai: openaiAdapter };

export function getAdapter(name: string): ProviderAdapter {
  const a = REGISTRY[name];
  if (!a) throw new Error(`unknown adapter: ${name}`);
  return a;
}
```

`src/adapters/registry.ts`:
```ts
export { getAdapter } from './openai';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/adapter-openai.test.ts`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/types.ts src/adapters/openai.ts src/adapters/registry.ts tests/adapter-openai.test.ts
git commit -m "feat: adapter interface + openai adapter + registry"
```

---

### Task 6: Upstream client (injectable fetch)

**Files:**
- Create: `src/core/upstream.ts`
- Create: `tests/upstream.test.ts`

**Interfaces:**
- Consumes: `UpstreamRequest` (Task 5).
- Produces:
  - `interface UpstreamResult { status: number; headers: Headers; json?: unknown; stream?: ReadableStream<Uint8Array> }`
  - `callUpstream(u: UpstreamRequest, stream: boolean, fetchFn?: typeof fetch): Promise<UpstreamResult>` — for `stream:true`, returns `stream` only when `resp.ok`; on a non-ok streamed request it reads the body and returns `json` instead so the caller can classify the error.

- [ ] **Step 1: Write the failing test**

`tests/upstream.test.ts`:
```ts
import { test, expect } from 'bun:test';
import { callUpstream } from '../src/core/upstream';
import type { UpstreamRequest } from '../src/adapters/types';

const u: UpstreamRequest = { url: 'https://x.test/chat/completions', headers: {}, body: '{}' };

test('non-stream returns parsed json', async () => {
  const fetchFn = (async () =>
    new Response(JSON.stringify({ ok: 1 }), { status: 200 })) as unknown as typeof fetch;
  const r = await callUpstream(u, false, fetchFn);
  expect(r.status).toBe(200);
  expect(r.json).toEqual({ ok: 1 });
  expect(r.stream).toBeUndefined();
});

test('stream ok returns stream', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) { ctrl.enqueue(new TextEncoder().encode('data: hi\n\n')); ctrl.close(); },
  });
  const fetchFn = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
  const r = await callUpstream(u, true, fetchFn);
  expect(r.status).toBe(200);
  expect(r.stream).toBeDefined();
});

test('stream but error status returns json for classification', async () => {
  const fetchFn = (async () =>
    new Response(JSON.stringify({ error: 'rl' }), { status: 429 })) as unknown as typeof fetch;
  const r = await callUpstream(u, true, fetchFn);
  expect(r.status).toBe(429);
  expect(r.stream).toBeUndefined();
  expect(r.json).toEqual({ error: 'rl' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/upstream.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`src/core/upstream.ts`:
```ts
import type { UpstreamRequest } from '../adapters/types';

export interface UpstreamResult {
  status: number;
  headers: Headers;
  json?: unknown;
  stream?: ReadableStream<Uint8Array>;
}

export async function callUpstream(
  u: UpstreamRequest,
  stream: boolean,
  fetchFn: typeof fetch = fetch
): Promise<UpstreamResult> {
  const resp = await fetchFn(u.url, { method: 'POST', headers: u.headers, body: u.body });
  if (stream && resp.ok && resp.body) {
    return { status: resp.status, headers: resp.headers, stream: resp.body };
  }
  const text = await resp.text();
  let json: unknown;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = { raw: text }; }
  return { status: resp.status, headers: resp.headers, json };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/upstream.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/upstream.ts tests/upstream.test.ts
git commit -m "feat: injectable upstream client"
```

---

### Task 7: Single-account selection

**Files:**
- Create: `src/core/select.ts`
- Create: `tests/select.test.ts`

**Interfaces:**
- Consumes: `listEnabledAccountsForModel` (Task 2), `StaticKeyCredential` (Task 4), `ResolvedAccount` (Task 2).
- Produces:
  - `interface Selection { account: ResolvedAccount; apiKey: string }`
  - `selectAccountForModel(db: Database, publicModel: string, masterKeyHex: string): Promise<Selection | null>` — returns the first enabled account serving the model with its decrypted key, or `null` if none. (Phase 1B replaces this with the pooling router.)

- [ ] **Step 1: Write the failing test**

`tests/select.test.ts`:
```ts
import { test, expect } from 'bun:test';
import { openDb, applySchema } from '../src/data/db';
import { insertAccount } from '../src/data/accounts';
import { encryptSecret } from '../src/credentials/crypto';
import { selectAccountForModel } from '../src/core/select';

const KEY = 'a'.repeat(64);

test('selects account and decrypts key', async () => {
  const db = openDb(':memory:');
  applySchema(db);
  insertAccount(db, {
    name: 'glm', provider: 'glm', adapter: 'openai', baseUrl: 'https://x.test/v1',
    models: [{ public: 'glm-4.6', target: 'glm-4.6' }], weight: 1, egress: null,
    secretEnc: encryptSecret('sk-up', KEY),
  });
  const sel = await selectAccountForModel(db, 'glm-4.6', KEY);
  expect(sel?.account.name).toBe('glm');
  expect(sel?.apiKey).toBe('sk-up');
  expect(await selectAccountForModel(db, 'missing', KEY)).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/select.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`src/core/select.ts`:
```ts
import type { Database } from 'bun:sqlite';
import { listEnabledAccountsForModel, type ResolvedAccount } from '../data/accounts';
import { StaticKeyCredential } from '../credentials/static-key';

export interface Selection { account: ResolvedAccount; apiKey: string; }

export async function selectAccountForModel(
  db: Database, publicModel: string, masterKeyHex: string
): Promise<Selection | null> {
  const candidates = listEnabledAccountsForModel(db, publicModel);
  if (candidates.length === 0) return null;
  const chosen = candidates[0];
  const apiKey = await new StaticKeyCredential(chosen.secretEnc, masterKeyHex).getApiKey();
  const { secretEnc, ...account } = chosen;
  return { account, apiKey };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/select.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/select.ts tests/select.test.ts
git commit -m "feat: single-account selection"
```

---

### Task 8: Request logging + cost estimate

**Files:**
- Create: `src/usage/cost.ts`
- Create: `src/usage/logger.ts`
- Create: `tests/logger.test.ts`

**Interfaces:**
- Consumes: `Database`, schema `request_logs` (Task 2).
- Produces:
  - `estimateCost(model: string, promptTokens: number, completionTokens: number): number`
  - `interface RequestLogEntry` (fields below)
  - `logRequest(db: Database, e: RequestLogEntry): void`
  - `countLogs(db: Database): number` (test helper, also useful for `/admin/stats` later)

- [ ] **Step 1: Write the failing test**

`tests/logger.test.ts`:
```ts
import { test, expect } from 'bun:test';
import { openDb, applySchema } from '../src/data/db';
import { logRequest, countLogs } from '../src/usage/logger';
import { estimateCost } from '../src/usage/cost';

test('estimateCost returns 0 for unknown model', () => {
  expect(estimateCost('unknown', 1000, 1000)).toBe(0);
});

test('logRequest writes a row', () => {
  const db = openDb(':memory:');
  applySchema(db);
  logRequest(db, {
    publicModel: 'glm-4.6', accountId: 'a1', status: 'ok', httpStatus: 200,
    latencyMs: 42, promptTokens: 10, completionTokens: 5, totalTokens: 15,
    estCost: 0, attemptCount: 1, stream: false,
  });
  expect(countLogs(db)).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/logger.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`src/usage/cost.ts`:
```ts
// USD per 1M tokens. Illustrative defaults — treat as configurable; extend per public model.
const PRICE_MAP: Record<string, { in: number; out: number }> = {
  'glm-4.6': { in: 0.6, out: 2.2 },
};

export function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const p = PRICE_MAP[model];
  if (!p) return 0;
  return (promptTokens / 1e6) * p.in + (completionTokens / 1e6) * p.out;
}
```

`src/usage/logger.ts`:
```ts
import type { Database } from 'bun:sqlite';

export interface RequestLogEntry {
  gatewayKeyId?: string | null;
  publicModel?: string | null;
  accountId?: string | null;
  status: 'ok' | 'error' | 'failover';
  httpStatus?: number | null;
  latencyMs?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  estCost?: number | null;
  attemptCount?: number | null;
  stream?: boolean | null;
  clientIp?: string | null;
}

export function logRequest(db: Database, e: RequestLogEntry): void {
  db.query(
    `INSERT INTO request_logs
       (id,ts,gateway_key_id,public_model,account_id,status,http_status,latency_ms,
        prompt_tokens,completion_tokens,total_tokens,est_cost,attempt_count,stream,client_ip)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    crypto.randomUUID(), Date.now(), e.gatewayKeyId ?? null, e.publicModel ?? null,
    e.accountId ?? null, e.status, e.httpStatus ?? null, e.latencyMs ?? null,
    e.promptTokens ?? null, e.completionTokens ?? null, e.totalTokens ?? null,
    e.estCost ?? null, e.attemptCount ?? null, e.stream ? 1 : 0, e.clientIp ?? null
  );
}

export function countLogs(db: Database): number {
  return (db.query(`SELECT COUNT(*) AS n FROM request_logs`).get() as { n: number }).n;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/logger.test.ts`
Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add src/usage/cost.ts src/usage/logger.ts tests/logger.test.ts
git commit -m "feat: request logging + cost estimate"
```

---

### Task 9: Gateway-key auth

**Files:**
- Create: `src/ingress/auth.ts`
- Create: `tests/auth.test.ts`

**Interfaces:**
- Consumes: `Database`, schema `gateway_keys` (Task 2).
- Produces:
  - `hashKey(raw: string): string` (sha256 hex)
  - `seedGatewayKey(db: Database, rawKey: string, name?: string): void` (idempotent)
  - `verifyGatewayKey(db: Database, authHeader: string | undefined): boolean`

- [ ] **Step 1: Write the failing test**

`tests/auth.test.ts`:
```ts
import { test, expect } from 'bun:test';
import { openDb, applySchema } from '../src/data/db';
import { seedGatewayKey, verifyGatewayKey } from '../src/ingress/auth';

function db() { const d = openDb(':memory:'); applySchema(d); return d; }

test('verifies a seeded key, rejects others', () => {
  const d = db();
  seedGatewayKey(d, 'gw-secret');
  seedGatewayKey(d, 'gw-secret'); // idempotent, no throw
  expect(verifyGatewayKey(d, 'Bearer gw-secret')).toBe(true);
  expect(verifyGatewayKey(d, 'Bearer wrong')).toBe(false);
  expect(verifyGatewayKey(d, undefined)).toBe(false);
  expect(verifyGatewayKey(d, 'gw-secret')).toBe(false); // missing Bearer
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/auth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`src/ingress/auth.ts`:
```ts
import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';

export function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function seedGatewayKey(db: Database, rawKey: string, name = 'bootstrap'): void {
  const h = hashKey(rawKey);
  const existing = db.query(`SELECT id FROM gateway_keys WHERE key_hash = ?`).get(h);
  if (existing) return;
  db.query(`INSERT INTO gateway_keys (id,key_hash,name,enabled,created_at) VALUES (?,?,?,1,?)`)
    .run(crypto.randomUUID(), h, name, Date.now());
}

export function verifyGatewayKey(db: Database, authHeader: string | undefined): boolean {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  const raw = authHeader.slice('Bearer '.length).trim();
  if (!raw) return false;
  const row = db.query(`SELECT enabled FROM gateway_keys WHERE key_hash = ?`).get(hashKey(raw)) as
    | { enabled: number }
    | null;
  return !!row && row.enabled === 1;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ingress/auth.ts tests/auth.test.ts
git commit -m "feat: gateway-key auth (sha256)"
```

---

### Task 10: OpenAI routes — `/v1/models` + `/v1/chat/completions`

**Files:**
- Create: `src/ingress/openai-routes.ts`
- Modify: `src/server.ts` (accept `AppDeps`, mount routes)
- Modify: `src/index.ts` (wire real db + env, seed gateway key)
- Modify: `tests/server.test.ts` (pass deps to `buildApp`)
- Create: `tests/chat.test.ts`

**Interfaces:**
- Consumes: `verifyGatewayKey` (T9), `selectAccountForModel` (T7), `getAdapter` (T5), `callUpstream` (T6), `logRequest`/`estimateCost` (T8), `listPublicModels` (T2).
- Produces: `buildApp(deps: AppDeps): Hono` where `AppDeps = { db: Database; masterKeyHex: string; fetchFn?: typeof fetch }`; mounts `GET /v1/models` and `POST /v1/chat/completions`.

- [ ] **Step 1: Write the failing test**

`tests/chat.test.ts`:
```ts
import { test, expect } from 'bun:test';
import { openDb, applySchema } from '../src/data/db';
import { insertAccount } from '../src/data/accounts';
import { encryptSecret } from '../src/credentials/crypto';
import { seedGatewayKey } from '../src/ingress/auth';
import { countLogs } from '../src/usage/logger';
import { buildApp } from '../src/server';

const KEY = 'a'.repeat(64);

function setup() {
  const db = openDb(':memory:');
  applySchema(db);
  seedGatewayKey(db, 'gw');
  insertAccount(db, {
    name: 'glm', provider: 'glm', adapter: 'openai', baseUrl: 'https://up.test/v1',
    models: [{ public: 'glm-4.6', target: 'glm-real' }], weight: 1, egress: null,
    secretEnc: encryptSecret('sk-up', KEY),
  });
  return db;
}

test('401 without valid gateway key', async () => {
  const db = setup();
  const app = buildApp({ db, masterKeyHex: KEY, fetchFn: (async () => new Response('{}')) as unknown as typeof fetch });
  const res = await app.request('/v1/chat/completions', { method: 'POST', body: '{}' });
  expect(res.status).toBe(401);
});

test('GET /v1/models lists public names', async () => {
  const db = setup();
  const app = buildApp({ db, masterKeyHex: KEY });
  const res = await app.request('/v1/models', { headers: { authorization: 'Bearer gw' } });
  const body = await res.json();
  expect(body.data.map((m: { id: string }) => m.id)).toEqual(['glm-4.6']);
});

test('non-stream chat proxies to upstream and logs', async () => {
  const db = setup();
  const upstreamJson = { id: 'x', choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } };
  let seenBody: any = null;
  const fetchFn = (async (_url: string, init: RequestInit) => {
    seenBody = JSON.parse(init.body as string);
    return new Response(JSON.stringify(upstreamJson), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const app = buildApp({ db, masterKeyHex: KEY, fetchFn });
  const res = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer gw', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-4.6', messages: [{ role: 'user', content: 'hey' }] }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).choices[0].message.content).toBe('hi');
  expect(seenBody.model).toBe('glm-real'); // adapter renamed public->target
  expect(countLogs(db)).toBe(1);
});

test('stream chat pipes SSE through', async () => {
  const db = setup();
  const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
  const fetchFn = (async () => new Response(
    new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  )) as unknown as typeof fetch;
  const app = buildApp({ db, masterKeyHex: KEY, fetchFn });
  const res = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer gw', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-4.6', stream: true, messages: [{ role: 'user', content: 'hey' }] }),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  expect(await res.text()).toContain('"content":"hi"');
});

test('missing model -> 404 no-account', async () => {
  const db = setup();
  const app = buildApp({ db, masterKeyHex: KEY, fetchFn: (async () => new Response('{}')) as unknown as typeof fetch });
  const res = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer gw', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'does-not-exist', messages: [] }),
  });
  expect(res.status).toBe(404);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/chat.test.ts`
Expected: FAIL — `buildApp` takes no deps / routes missing.

- [ ] **Step 3: Write the routes**

`src/ingress/openai-routes.ts`:
```ts
import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import { verifyGatewayKey } from './auth';
import { selectAccountForModel } from '../core/select';
import { getAdapter } from '../adapters/registry';
import { callUpstream } from '../core/upstream';
import { listPublicModels } from '../data/accounts';
import { logRequest, estimateCost } from '../usage';
import type { ChatRequest } from '../adapters/types';

export interface RouteDeps { db: Database; masterKeyHex: string; fetchFn?: typeof fetch; }

export function registerOpenAIRoutes(app: Hono, deps: RouteDeps): void {
  const { db, masterKeyHex } = deps;
  const fetchFn = deps.fetchFn ?? fetch;

  app.use('/v1/*', async (c, next) => {
    if (!verifyGatewayKey(db, c.req.header('authorization'))) {
      return c.json({ error: { message: 'invalid gateway key', type: 'auth' } }, 401);
    }
    await next();
  });

  app.get('/v1/models', (c) => {
    const data = listPublicModels(db).map((id) => ({ id, object: 'model', owned_by: 'mixapi' }));
    return c.json({ object: 'list', data });
  });

  app.post('/v1/chat/completions', async (c) => {
    const started = Date.now();
    const req = (await c.req.json()) as Partial<ChatRequest>;
    if (!req.model) return c.json({ error: { message: 'model required', type: 'bad_request' } }, 400);
    const stream = req.stream === true;

    const sel = await selectAccountForModel(db, req.model, masterKeyHex);
    if (!sel) {
      logRequest(db, { publicModel: req.model, status: 'error', httpStatus: 404, stream, attemptCount: 0 });
      return c.json({ error: { message: `no account serves model ${req.model}`, type: 'not_found' } }, 404);
    }

    const adapter = getAdapter(sel.account.adapter);
    const chatReq: ChatRequest = { messages: [], ...req, model: req.model, stream } as ChatRequest;
    const upstream = adapter.buildRequest(chatReq, sel.account, sel.apiKey);
    const result = await callUpstream(upstream, stream, fetchFn);

    // error (covers both non-stream errors and stream requests that came back non-ok)
    if (result.status >= 400 || (stream && !result.stream)) {
      const cls = adapter.classifyError(result.status, result.json, result.headers);
      logRequest(db, {
        publicModel: req.model, accountId: sel.account.id, status: 'error',
        httpStatus: result.status, latencyMs: Date.now() - started, stream, attemptCount: 1,
      });
      return c.json({ error: { message: `upstream error (${cls.reason})`, type: cls.reason } }, result.status as any);
    }

    if (stream && result.stream) {
      logRequest(db, {
        publicModel: req.model, accountId: sel.account.id, status: 'ok',
        httpStatus: 200, latencyMs: Date.now() - started, stream: true, attemptCount: 1,
      });
      return new Response(result.stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
      });
    }

    const parsed = adapter.parseResponse(result.status, result.json) as any;
    const usage = parsed?.usage ?? {};
    logRequest(db, {
      publicModel: req.model, accountId: sel.account.id, status: 'ok', httpStatus: result.status,
      latencyMs: Date.now() - started,
      promptTokens: usage.prompt_tokens ?? null, completionTokens: usage.completion_tokens ?? null,
      totalTokens: usage.total_tokens ?? null,
      estCost: estimateCost(req.model, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0),
      attemptCount: 1, stream: false,
    });
    return c.json(parsed, result.status as any);
  });
}
```

- [ ] **Step 4: Add a `usage` barrel and rewire `server.ts` / `index.ts`**

Create `src/usage/index.ts`:
```ts
export { logRequest, countLogs } from './logger';
export type { RequestLogEntry } from './logger';
export { estimateCost } from './cost';
```

Replace `src/server.ts`:
```ts
import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import { registerOpenAIRoutes } from './ingress/openai-routes';

export interface AppDeps { db: Database; masterKeyHex: string; fetchFn?: typeof fetch; }

export function buildApp(deps?: AppDeps): Hono {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  if (deps) registerOpenAIRoutes(app, deps);
  return app;
}
```

Update `tests/server.test.ts` (healthz still works with no deps — no change needed; keep as-is).

Replace `src/index.ts`:
```ts
import { buildApp } from './server';
import { openDb, applySchema } from './data/db';
import { seedGatewayKey } from './ingress/auth';

const masterKeyHex = process.env.MASTER_KEY ?? '';
if (masterKeyHex.length !== 64) throw new Error('MASTER_KEY must be 64 hex chars (32 bytes)');

const db = openDb(process.env.DB_PATH ?? './mixapi.sqlite');
applySchema(db);
if (process.env.GATEWAY_KEY) seedGatewayKey(db, process.env.GATEWAY_KEY);

const app = buildApp({ db, masterKeyHex });
const port = Number(process.env.PORT ?? 8080);
console.log(`mixapi listening on :${port}`);
export default { port, fetch: app.fetch };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test`
Expected: all suites pass (server, data, crypto, credentials, adapter-openai, upstream, select, logger, auth, chat).

- [ ] **Step 6: Commit**

```bash
git add src/ingress/openai-routes.ts src/server.ts src/index.ts src/usage/index.ts tests/chat.test.ts
git commit -m "feat: OpenAI-compatible chat + models routes (single account)"
```

---

## Phase 1A Definition of Done

- `bun test` green across all suites.
- With `MASTER_KEY`, `GATEWAY_KEY` set and one account inserted, `bun run dev` serves:
  - `GET /v1/models` → the account's public model名.
  - `POST /v1/chat/completions` (non-stream) → OpenAI-shaped response, a `request_logs` row, model renamed public→target upstream.
  - `POST /v1/chat/completions` with `stream:true` → SSE passthrough.
  - Bad/absent gateway key → 401; unknown model → 404.
- `credentials.secret_enc` is ciphertext in the DB; no token appears in any log line.

---

## Phase 1B Preview (next plan — gets its own full write-up)

Each task TDD'd like above; full code in the 1B plan.

1. **Health state machine** (`src/core/health.ts`): apply `ErrorClassification` → status transitions (`healthy`/`cooling`/`exhausted`/`disabled`/`unknown`), cooldown timestamps (honor `Retry-After`), consecutive-error circuit breaker, cooldown-expiry recovery. Persists to `account_state`.
2. **Pool** (`src/core/pool.ts`): candidate query joining `accounts` + `account_state`, filtering by enabled/status/cooldown/model.
3. **Router** (`src/core/router.ts`): `x-session-id` sticky consistent-hash (skip when absent) → weighted selection with power-of-two-choices tie-break over healthy candidates.
4. **Failover** (`src/core/failover.ts`): `maxAttempts` loop over distinct candidates with **pre-flight-then-commit** streaming — obtain the first upstream chunk before committing an account; retryable pre-first-chunk error → next candidate; non-retryable → return; after first chunk → error-terminate (never double-produce). Replaces Task 7's `selectAccountForModel` call site in the chat route.
5. **Anthropic adapter** (`src/adapters/anthropic.ts`): OpenAI⇄Anthropic request translation (system extraction, `max_tokens`) and streaming event mapping (`content_block_delta` → OpenAI `chat.completion.chunk`), plus Anthropic error classification. Register in adapter registry. (Enables GLM coding-plan接入.)
6. **Admin routes** (`src/ingress/admin-routes.ts`): admin-key auth; accounts CRUD (encrypt on write via `encryptSecret`), `account_state` view + `enable/disable/reset-cooldown`, `/admin/logs`, `/admin/stats`, `/admin/gateway-keys`.
7. **Config bootstrap** (`src/config/load.ts`): first-run import of accounts/keys from `config.yaml` into the DB (DB remains runtime authority).
8. **Acceptance suite** (`tests/acceptance/`): mock upstream server driving the spec's 7 DoD scenarios end-to-end (esp. failover-before-first-token and cooldown recovery).
