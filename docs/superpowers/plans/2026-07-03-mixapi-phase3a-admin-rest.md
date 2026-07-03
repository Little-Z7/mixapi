# mixapi Phase 3a — Admin REST + Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A headless, fully-tested Admin REST layer for mixapi: admin-key login backed by a stateless HMAC session cookie, plus endpoints to manage accounts (CRUD + health), gateway-keys (create-once / revoke), and read logs / usage stats — with account secrets write-only (never returned).

**Architecture:** New `src/admin/` (session + queries) and `src/ingress/admin-routes.ts` mounting under `/admin`, registered in `buildApp` (gated on `ADMIN_KEY` being set). A `/admin/*` middleware verifies an httpOnly, SameSite=Strict HMAC cookie (except the public login POST and the static page GET). Reuses the existing repos + crypto; adds focused admin repo functions. No schema change. The console UI (Phase 3b) consumes these endpoints.

**Tech Stack:** TypeScript · Bun (`bun test`, `bun:sqlite`) · Hono (incl. `hono/cookie`, no new dep) · `node:crypto`. Builds on `main` @ `2e84a27`.

## Global Constraints

- Runtime **Bun**; tests run with `bun test`; DB driver **`bun:sqlite`**.
- **Zero new dependencies** — session HMAC via `node:crypto`; cookies via `hono/cookie` (already in Hono).
- Admin auth uses a **separate `ADMIN_KEY`** env (distinct from `GATEWAY_KEY`/`MASTER_KEY`); verified with a **timing-safe** compare.
- Session cookie is **httpOnly + SameSite=Strict** (+ `Secure` unless `ADMIN_INSECURE_COOKIE=1`), a **stateless HMAC token `${exp}.${mac}`** with a 12h TTL; verified server-side.
- **Account API keys are write-only**: no endpoint ever returns `secretEnc` or a plaintext key. A gateway-key's raw value is returned **only once**, at creation; thereafter only its hash/prefix.
- **No schema change** — reuse `accounts`/`credentials`/`account_state`/`request_logs`/`gateway_keys`.
- `/admin/*` requires the session cookie EXCEPT `POST /admin/login` and `GET /admin` (the static page shell).
- **Never log secrets.** Timestamps `Date.now()`; ids `crypto.randomUUID()`. Follow **TDD**; frequent commits.

---

### Task 1: Stateless HMAC session (`admin/session.ts`)

**Files:**
- Create: `src/admin/session.ts`
- Test: `tests/admin-session.test.ts`

**Interfaces:**
- Consumes: `hashKey` from `src/ingress/auth.ts` (1A).
- Produces:
  - `signSession(adminKey: string, now?: number): string`
  - `verifySession(adminKey: string, token: string | undefined, now?: number): boolean`
  - `SESSION_TTL_MS` (exported const)

- [ ] **Step 1: Write the failing test**

`tests/admin-session.test.ts`:
```ts
import { test, expect } from 'bun:test';
import { signSession, verifySession, SESSION_TTL_MS } from '../src/admin/session';

const KEY = 'admin-secret';

test('sign then verify round-trips', () => {
  const t = signSession(KEY, 1000);
  expect(verifySession(KEY, t, 2000)).toBe(true);
});

test('expired token is rejected', () => {
  const t = signSession(KEY, 1000);
  expect(verifySession(KEY, t, 1000 + SESSION_TTL_MS + 1)).toBe(false);
});

test('tampered mac is rejected', () => {
  const t = signSession(KEY, 1000);
  const bad = t.slice(0, -1) + (t.endsWith('a') ? 'b' : 'a');
  expect(verifySession(KEY, bad, 2000)).toBe(false);
});

test('wrong admin key is rejected', () => {
  const t = signSession(KEY, 1000);
  expect(verifySession('other-secret', t, 2000)).toBe(false);
});

test('missing / malformed token is rejected', () => {
  expect(verifySession(KEY, undefined, 2000)).toBe(false);
  expect(verifySession(KEY, 'no-dot-here', 2000)).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/admin-session.test.ts`
Expected: FAIL — module `../src/admin/session` not found.

- [ ] **Step 3: Implement**

`src/admin/session.ts`:
```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import { hashKey } from '../ingress/auth';

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function secret(adminKey: string): string {
  return hashKey('session:' + adminKey);
}

export function signSession(adminKey: string, now: number = Date.now()): string {
  const exp = now + SESSION_TTL_MS;
  const mac = createHmac('sha256', secret(adminKey)).update(String(exp)).digest('hex');
  return `${exp}.${mac}`;
}

export function verifySession(adminKey: string, token: string | undefined, now: number = Date.now()): boolean {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const expStr = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= now) return false;
  const expected = createHmac('sha256', secret(adminKey)).update(expStr).digest('hex');
  if (mac.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/admin-session.test.ts` → 5 pass. Then `bun test` (whole suite green).

- [ ] **Step 5: Commit**

```bash
git add src/admin/session.ts tests/admin-session.test.ts
git commit -m "feat: stateless HMAC admin session"
```

---

### Task 2: Account admin repo functions (`data/accounts.ts`)

**Files:**
- Modify: `src/data/accounts.ts` (append functions)
- Test: `tests/admin-accounts.test.ts`

**Interfaces:**
- Consumes: existing schema; `ResolvedAccount`, `ModelMap`, `insertAccount` (1A).
- Produces:
  - `interface AccountState { status: string; cooldownUntil: number|null; consecutiveErrors: number; lastUsedAt: number|null; lastError: string|null }`
  - `interface AccountWithState extends ResolvedAccount { enabled: boolean; state: AccountState }`
  - `interface AccountPatch { baseUrl?: string; models?: ModelMap[]; weight?: number; enabled?: boolean }`
  - `listAccountsWithState(db: Database): AccountWithState[]`
  - `updateAccount(db: Database, id: string, patch: AccountPatch): void`
  - `deleteAccount(db: Database, id: string): void`
  - `setCredential(db: Database, accountId: string, secretEnc: Uint8Array): void`
  - `resetCooldown(db: Database, id: string): void`

- [ ] **Step 1: Write the failing test**

`tests/admin-accounts.test.ts`:
```ts
import { test, expect } from 'bun:test';
import { openDb, applySchema } from '../src/data/db';
import { insertAccount, listAccountsWithState, updateAccount, deleteAccount, setCredential, resetCooldown } from '../src/data/accounts';

function seed() {
  const db = openDb(':memory:'); applySchema(db);
  const id = insertAccount(db, {
    name: 'a', provider: 'glm', adapter: 'openai', baseUrl: 'https://x.test/v1',
    models: [{ public: 'm', target: 'm' }], weight: 1, egress: null, secretEnc: new Uint8Array([1]),
  });
  return { db, id };
}

test('listAccountsWithState returns account + state, never secretEnc', () => {
  const { db } = seed();
  const rows = listAccountsWithState(db);
  expect(rows.length).toBe(1);
  expect(rows[0].name).toBe('a');
  expect(rows[0].enabled).toBe(true);
  expect(rows[0].state.status).toBe('unknown');
  expect((rows[0] as any).secretEnc).toBeUndefined();
});

test('updateAccount changes provided fields only', () => {
  const { db, id } = seed();
  updateAccount(db, id, { weight: 5, enabled: false, baseUrl: 'https://y.test/v1' });
  const r = listAccountsWithState(db)[0];
  expect(r.weight).toBe(5);
  expect(r.enabled).toBe(false);
  expect(r.baseUrl).toBe('https://y.test/v1');
  expect(r.models[0].public).toBe('m'); // untouched
});

test('deleteAccount removes account, credential and state', () => {
  const { db, id } = seed();
  deleteAccount(db, id);
  expect(listAccountsWithState(db).length).toBe(0);
  expect((db.query('SELECT COUNT(*) AS n FROM credentials').get() as any).n).toBe(0);
  expect((db.query('SELECT COUNT(*) AS n FROM account_state').get() as any).n).toBe(0);
});

test('setCredential replaces the stored secret', () => {
  const { db, id } = seed();
  setCredential(db, id, new Uint8Array([9, 9]));
  const row = db.query('SELECT secret_enc FROM credentials WHERE account_id=?').get(id) as any;
  expect(Array.from(row.secret_enc as Uint8Array)).toEqual([9, 9]);
});

test('resetCooldown clears cooling state', () => {
  const { db, id } = seed();
  db.query("UPDATE account_state SET status='cooling', cooldown_until=999, consecutive_errors=3 WHERE account_id=?").run(id);
  resetCooldown(db, id);
  const s = db.query('SELECT status,cooldown_until,consecutive_errors FROM account_state WHERE account_id=?').get(id) as any;
  expect(s).toMatchObject({ status: 'unknown', cooldown_until: null, consecutive_errors: 0 });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/admin-accounts.test.ts`
Expected: FAIL — `listAccountsWithState` not exported.

- [ ] **Step 3: Implement (append to `src/data/accounts.ts`)**

```ts
export interface AccountState {
  status: string; cooldownUntil: number | null; consecutiveErrors: number;
  lastUsedAt: number | null; lastError: string | null;
}
export interface AccountWithState extends ResolvedAccount { enabled: boolean; state: AccountState; }
export interface AccountPatch { baseUrl?: string; models?: ModelMap[]; weight?: number; enabled?: boolean; }

interface AdminRow extends AccountRow {
  enabled: number; status: string | null; cooldown_until: number | null;
  consecutive_errors: number | null; last_used_at: number | null; last_error: string | null;
}

export function listAccountsWithState(db: Database): AccountWithState[] {
  const rows = db.query(
    `SELECT a.id,a.name,a.provider,a.adapter,a.base_url,a.models,a.weight,a.egress,a.enabled,
            s.status,s.cooldown_until,s.consecutive_errors,s.last_used_at,s.last_error
     FROM accounts a LEFT JOIN account_state s ON s.account_id = a.id
     ORDER BY a.created_at ASC`
  ).all() as AdminRow[];
  return rows.map((r) => ({
    ...rowToResolved(r), enabled: r.enabled === 1,
    state: {
      status: r.status ?? 'unknown', cooldownUntil: r.cooldown_until,
      consecutiveErrors: r.consecutive_errors ?? 0, lastUsedAt: r.last_used_at, lastError: r.last_error,
    },
  }));
}

export function updateAccount(db: Database, id: string, patch: AccountPatch): void {
  const sets: string[] = [];
  const vals: (string | number)[] = [];
  if (patch.baseUrl !== undefined) { sets.push('base_url=?'); vals.push(patch.baseUrl); }
  if (patch.models !== undefined) { sets.push('models=?'); vals.push(JSON.stringify(patch.models)); }
  if (patch.weight !== undefined) { sets.push('weight=?'); vals.push(patch.weight); }
  if (patch.enabled !== undefined) { sets.push('enabled=?'); vals.push(patch.enabled ? 1 : 0); }
  sets.push('updated_at=?'); vals.push(Date.now());
  db.query(`UPDATE accounts SET ${sets.join(', ')} WHERE id=?`).run(...vals, id);
}

export function deleteAccount(db: Database, id: string): void {
  db.transaction(() => {
    db.query('DELETE FROM credentials WHERE account_id=?').run(id);
    db.query('DELETE FROM account_state WHERE account_id=?').run(id);
    db.query('DELETE FROM accounts WHERE id=?').run(id);
  })();
}

export function setCredential(db: Database, accountId: string, secretEnc: Uint8Array): void {
  db.query('UPDATE credentials SET secret_enc=? WHERE account_id=?').run(secretEnc, accountId);
}

export function resetCooldown(db: Database, id: string): void {
  db.query(
    `UPDATE account_state SET status='unknown', cooldown_until=NULL, consecutive_errors=0 WHERE account_id=?`
  ).run(id);
}
```
> `AccountRow`, `rowToResolved` already exist in this file (1A). `AdminRow` extends `AccountRow` with the joined state columns.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/admin-accounts.test.ts` → 5 pass. Then `bun test`; `bunx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add src/data/accounts.ts tests/admin-accounts.test.ts
git commit -m "feat: admin account repo (list-with-state, update, delete, setCredential, resetCooldown)"
```

---

### Task 3: Gateway-key admin functions (`ingress/auth.ts`)

**Files:**
- Modify: `src/ingress/auth.ts` (append functions)
- Test: `tests/admin-keys.test.ts`

**Interfaces:**
- Consumes: `hashKey`, `verifyGatewayKey` (1A); `gateway_keys` schema.
- Produces:
  - `interface GatewayKeyInfo { id: string; name: string|null; keyHashPrefix: string; enabled: boolean; createdAt: number }`
  - `listGatewayKeys(db: Database): GatewayKeyInfo[]`
  - `createGatewayKey(db: Database, name: string): { id: string; key: string }` (raw key returned once)
  - `deleteGatewayKey(db: Database, id: string): void`

- [ ] **Step 1: Write the failing test**

`tests/admin-keys.test.ts`:
```ts
import { test, expect } from 'bun:test';
import { openDb, applySchema } from '../src/data/db';
import { createGatewayKey, listGatewayKeys, deleteGatewayKey, verifyGatewayKey } from '../src/ingress/auth';

function db2() { const d = openDb(':memory:'); applySchema(d); return d; }

test('createGatewayKey returns a usable raw key, stores only the hash', () => {
  const db = db2();
  const { id, key } = createGatewayKey(db, 'ci');
  expect(id).toBeTruthy();
  expect(key).toMatch(/^mk-/);
  expect(verifyGatewayKey(db, `Bearer ${key}`)).toBe(true);      // the raw key works
  const stored = db.query('SELECT key_hash FROM gateway_keys WHERE id=?').get(id) as any;
  expect(stored.key_hash).not.toContain(key);                    // raw not stored
});

test('listGatewayKeys is masked (no raw key), shows hash prefix', () => {
  const db = db2();
  const { key } = createGatewayKey(db, 'ci');
  const list = listGatewayKeys(db);
  expect(list.length).toBe(1);
  expect(list[0].name).toBe('ci');
  expect(list[0].enabled).toBe(true);
  expect(list[0].keyHashPrefix.length).toBe(8);
  expect(JSON.stringify(list)).not.toContain(key);               // raw never present
});

test('deleteGatewayKey revokes it', () => {
  const db = db2();
  const { id, key } = createGatewayKey(db, 'ci');
  deleteGatewayKey(db, id);
  expect(verifyGatewayKey(db, `Bearer ${key}`)).toBe(false);
  expect(listGatewayKeys(db).length).toBe(0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/admin-keys.test.ts`
Expected: FAIL — `createGatewayKey` not exported.

- [ ] **Step 3: Implement (append to `src/ingress/auth.ts`)**

Add `randomBytes` to the `node:crypto` import at the top (it currently imports `createHash`), then append:
```ts
export interface GatewayKeyInfo {
  id: string; name: string | null; keyHashPrefix: string; enabled: boolean; createdAt: number;
}

export function listGatewayKeys(db: Database): GatewayKeyInfo[] {
  const rows = db.query('SELECT id,name,key_hash,enabled,created_at FROM gateway_keys ORDER BY created_at ASC')
    .all() as { id: string; name: string | null; key_hash: string; enabled: number; created_at: number }[];
  return rows.map((r) => ({
    id: r.id, name: r.name, keyHashPrefix: r.key_hash.slice(0, 8), enabled: r.enabled === 1, createdAt: r.created_at,
  }));
}

export function createGatewayKey(db: Database, name: string): { id: string; key: string } {
  const key = 'mk-' + randomBytes(24).toString('hex');
  const id = crypto.randomUUID();
  db.query('INSERT INTO gateway_keys (id,key_hash,name,enabled,created_at) VALUES (?,?,?,1,?)')
    .run(id, hashKey(key), name, Date.now());
  return { id, key };
}

export function deleteGatewayKey(db: Database, id: string): void {
  db.query('DELETE FROM gateway_keys WHERE id=?').run(id);
}
```
> The import line becomes: `import { createHash, randomBytes } from 'node:crypto';`

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/admin-keys.test.ts` → 3 pass. Then `bun test`; `bunx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add src/ingress/auth.ts tests/admin-keys.test.ts
git commit -m "feat: admin gateway-key management (create-once, list masked, revoke)"
```

---

### Task 4: Logs + stats queries (`admin/queries.ts`)

**Files:**
- Create: `src/admin/queries.ts`
- Test: `tests/admin-queries.test.ts`

**Interfaces:**
- Consumes: `request_logs` schema; `logRequest` (1A, in tests).
- Produces:
  - `interface LogFilter { limit?: number; model?: string; account?: string; status?: string }`
  - `listLogs(db: Database, f?: LogFilter): Record<string, unknown>[]`
  - `interface StatGroup { key: string; requests: number; errors: number; tokens: number; cost: number }`
  - `interface Stats { totalRequests: number; errorCount: number; errorRate: number; totalTokens: number; totalCost: number; byModel: StatGroup[]; byAccount: StatGroup[] }`
  - `aggregateStats(db: Database, sinceMs?: number): Stats`

- [ ] **Step 1: Write the failing test**

`tests/admin-queries.test.ts`:
```ts
import { test, expect } from 'bun:test';
import { openDb, applySchema } from '../src/data/db';
import { logRequest } from '../src/usage/logger';
import { listLogs, aggregateStats } from '../src/admin/queries';

function seed() {
  const db = openDb(':memory:'); applySchema(db);
  logRequest(db, { publicModel: 'm1', accountId: 'a1', status: 'ok', httpStatus: 200, totalTokens: 10, estCost: 0.01, attemptCount: 1 });
  logRequest(db, { publicModel: 'm1', accountId: 'a1', status: 'error', httpStatus: 429, totalTokens: 0, estCost: 0, attemptCount: 2 });
  logRequest(db, { publicModel: 'm2', accountId: 'a2', status: 'ok', httpStatus: 200, totalTokens: 5, estCost: 0.02, attemptCount: 1 });
  return db;
}

test('listLogs filters by status and model, newest first', () => {
  const db = seed();
  expect(listLogs(db, { status: 'error' }).length).toBe(1);
  expect(listLogs(db, { model: 'm1' }).length).toBe(2);
  expect(listLogs(db, { limit: 2 }).length).toBe(2);
});

test('aggregateStats totals, error rate and grouping', () => {
  const db = seed();
  const s = aggregateStats(db);
  expect(s.totalRequests).toBe(3);
  expect(s.errorCount).toBe(1);
  expect(s.errorRate).toBeCloseTo(1 / 3, 5);
  expect(s.totalTokens).toBe(15);
  expect(s.totalCost).toBeCloseTo(0.03, 5);
  expect(s.byModel.find((g) => g.key === 'm1')!.requests).toBe(2);
  expect(s.byAccount.find((g) => g.key === 'a2')!.tokens).toBe(5);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/admin-queries.test.ts`
Expected: FAIL — module `../src/admin/queries` not found.

- [ ] **Step 3: Implement**

`src/admin/queries.ts`:
```ts
import type { Database } from 'bun:sqlite';

export interface LogFilter { limit?: number; model?: string; account?: string; status?: string; }

export function listLogs(db: Database, f: LogFilter = {}): Record<string, unknown>[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.model) { where.push('public_model = ?'); args.push(f.model); }
  if (f.account) { where.push('account_id = ?'); args.push(f.account); }
  if (f.status) { where.push('status = ?'); args.push(f.status); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 1000);
  return db.query(`SELECT * FROM request_logs ${clause} ORDER BY ts DESC LIMIT ${limit}`)
    .all(...args) as Record<string, unknown>[];
}

export interface StatGroup { key: string; requests: number; errors: number; tokens: number; cost: number; }
export interface Stats {
  totalRequests: number; errorCount: number; errorRate: number;
  totalTokens: number; totalCost: number; byModel: StatGroup[]; byAccount: StatGroup[];
}

function groupBy(db: Database, column: string, since: number): StatGroup[] {
  const rows = db.query(
    `SELECT COALESCE(${column}, '(none)') AS key,
            COUNT(*) AS requests,
            SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors,
            COALESCE(SUM(total_tokens),0) AS tokens,
            COALESCE(SUM(est_cost),0) AS cost
     FROM request_logs WHERE ts >= ? GROUP BY ${column} ORDER BY requests DESC`
  ).all(since) as StatGroup[];
  return rows;
}

export function aggregateStats(db: Database, sinceMs: number = 0): Stats {
  const totals = db.query(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors,
            COALESCE(SUM(total_tokens),0) AS tokens,
            COALESCE(SUM(est_cost),0) AS cost
     FROM request_logs WHERE ts >= ?`
  ).get(sinceMs) as { total: number; errors: number; tokens: number; cost: number };
  return {
    totalRequests: totals.total, errorCount: totals.errors,
    errorRate: totals.total ? totals.errors / totals.total : 0,
    totalTokens: totals.tokens, totalCost: totals.cost,
    byModel: groupBy(db, 'public_model', sinceMs),
    byAccount: groupBy(db, 'account_id', sinceMs),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/admin-queries.test.ts` → 2 pass. Then `bun test`; `bunx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add src/admin/queries.ts tests/admin-queries.test.ts
git commit -m "feat: admin logs filter + usage stats aggregation"
```

---

### Task 5: Admin auth routes + middleware + wiring (`ingress/admin-routes.ts`)

**Files:**
- Create: `src/ingress/admin-routes.ts`
- Modify: `src/server.ts` (register admin routes when `deps.adminKey` set; extend `AppDeps`)
- Modify: `src/index.ts` (read `ADMIN_KEY` env, pass to `buildApp`)
- Test: `tests/admin-auth.test.ts`

**Interfaces:**
- Consumes: `verifySession`/`signSession` (Task 1), `hashKey` (1A), `getCookie`/`setCookie`/`deleteCookie` from `hono/cookie`.
- Produces:
  - `interface AdminDeps { db: Database; masterKeyHex: string; adminKey: string; }`
  - `registerAdminRoutes(app: Hono, deps: AdminDeps): void` — mounts the `/admin/*` auth middleware, `POST /admin/login`, `POST /admin/logout`, `GET /admin/session`, and a placeholder `GET /admin` page (replaced in Phase 3b).

- [ ] **Step 1: Write the failing test**

`tests/admin-auth.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/admin-auth.test.ts`
Expected: FAIL — `buildApp` doesn't accept `adminKey` / `/admin` routes absent.

- [ ] **Step 3: Implement `src/ingress/admin-routes.ts`**

```ts
import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { hashKey } from './auth';
import { signSession, verifySession, SESSION_TTL_MS } from '../admin/session';
import { timingSafeEqual } from 'node:crypto';

export interface AdminDeps { db: Database; masterKeyHex: string; adminKey: string; }

const COOKIE = 'mixadmin';
const SHELL = `<!doctype html><html><head><meta charset="utf-8"><title>mixapi admin</title></head>` +
  `<body><div id="app" data-login>mixapi admin — login required</div></body></html>`;

function keyMatches(input: string, adminKey: string): boolean {
  const a = Buffer.from(hashKey(input));
  const b = Buffer.from(hashKey(adminKey));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerAdminRoutes(app: Hono, deps: AdminDeps): void {
  const { adminKey } = deps;
  const secureCookie = process.env.ADMIN_INSECURE_COOKIE !== '1';

  // static shell (public) — the real page is Phase 3b
  app.get('/admin', (c) => c.html(SHELL));

  // auth gate for every /admin/* except the login POST
  app.use('/admin/*', async (c, next) => {
    if (c.req.path === '/admin' || c.req.path === '/admin/login') return next(); // public: shell + login
    if (!verifySession(adminKey, getCookie(c, COOKIE))) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });

  app.post('/admin/login', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.key !== 'string' || !keyMatches(body.key, adminKey)) {
      return c.json({ error: 'invalid admin key' }, 401);
    }
    setCookie(c, COOKIE, signSession(adminKey), {
      httpOnly: true, sameSite: 'Strict', secure: secureCookie, path: '/admin', maxAge: SESSION_TTL_MS / 1000,
    });
    return c.json({ authed: true });
  });

  app.post('/admin/logout', (c) => {
    deleteCookie(c, COOKIE, { path: '/admin' });
    return c.json({ authed: false });
  });

  app.get('/admin/session', (c) => c.json({ authed: true }));
}
```

- [ ] **Step 4: Wire into `server.ts` and `index.ts`**

In `src/server.ts`: extend `AppDeps` with `adminKey?: string`, import `registerAdminRoutes`, and register it inside the `if (deps)` block when an admin key is present:
```ts
import { registerAdminRoutes } from './ingress/admin-routes';
// ...inside AppDeps:  adminKey?: string;
// ...inside buildApp, after registerAnthropicRoutes(app, deps):
    if (deps.adminKey) registerAdminRoutes(app, { db: deps.db, masterKeyHex: deps.masterKeyHex, adminKey: deps.adminKey });
```

In `src/index.ts`: read the env and pass it:
```ts
// add near the other env reads:
const adminKey = process.env.ADMIN_KEY;
// change the buildApp call to include it:
const app = buildApp({ db, masterKeyHex, adminKey });
if (adminKey) console.log('admin console enabled at /admin');
```

- [ ] **Step 5: Run + commit**

Run: `bun test tests/admin-auth.test.ts` → 4 pass. Then `bun test` (existing suites unaffected — admin routes only register when `adminKey` is set; prior tests don't pass one). `bunx tsc --noEmit` clean.

```bash
git add src/ingress/admin-routes.ts src/server.ts src/index.ts tests/admin-auth.test.ts
git commit -m "feat: admin login/session/logout + /admin/* auth middleware + wiring"
```

---

### Task 6: Admin data routes (accounts / keys / logs / stats / models)

**Files:**
- Modify: `src/ingress/admin-routes.ts` (append data endpoints to `registerAdminRoutes`)
- Test: `tests/admin-data.test.ts`

**Interfaces:**
- Consumes: `listAccountsWithState`/`updateAccount`/`deleteAccount`/`setCredential`/`resetCooldown`/`insertAccount`/`listPublicModels` (Task 2 + 1A), `listGatewayKeys`/`createGatewayKey`/`deleteGatewayKey` (Task 3), `listLogs`/`aggregateStats` (Task 4), `encryptSecret` (1A).
- Produces: the `/admin` data endpoints from the spec (all cookie-gated by Task 5's middleware).

- [ ] **Step 1: Write the failing test**

`tests/admin-data.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/admin-data.test.ts`
Expected: FAIL — `/admin/accounts` etc. return 404 (routes not defined).

- [ ] **Step 3: Implement (append inside `registerAdminRoutes`, after `GET /admin/session`)**

Add these imports at the top of `src/ingress/admin-routes.ts`:
```ts
import { insertAccount, listAccountsWithState, updateAccount, deleteAccount, setCredential, resetCooldown, listPublicModels } from '../data/accounts';
import { listGatewayKeys, createGatewayKey, deleteGatewayKey } from './auth';
import { listLogs, aggregateStats } from '../admin/queries';
import { encryptSecret } from '../credentials/crypto';
```
Then append inside `registerAdminRoutes` (uses `deps.db`, `deps.masterKeyHex`):
```ts
  const { db, masterKeyHex } = deps;

  app.get('/admin/accounts', (c) => c.json(listAccountsWithState(db)));

  app.post('/admin/accounts', async (c) => {
    const b = await c.req.json();
    if (!b?.name || !b?.adapter || !b?.baseUrl || typeof b?.key !== 'string') {
      return c.json({ error: 'name, adapter, baseUrl, key required' }, 400);
    }
    const id = insertAccount(db, {
      name: b.name, provider: b.provider ?? 'custom', adapter: b.adapter, baseUrl: b.baseUrl,
      models: b.models ?? [], weight: b.weight ?? 1, egress: b.egress ?? null,
      secretEnc: encryptSecret(b.key, masterKeyHex),
    });
    return c.json({ id }, 201);
  });

  app.patch('/admin/accounts/:id', async (c) => {
    const id = c.req.param('id');
    const b = await c.req.json();
    updateAccount(db, id, { baseUrl: b.baseUrl, models: b.models, weight: b.weight, enabled: b.enabled });
    if (typeof b.key === 'string') setCredential(db, id, encryptSecret(b.key, masterKeyHex));
    return c.json({ ok: true });
  });

  app.delete('/admin/accounts/:id', (c) => { deleteAccount(db, c.req.param('id')); return c.json({ ok: true }); });
  app.post('/admin/accounts/:id/reset-cooldown', (c) => { resetCooldown(db, c.req.param('id')); return c.json({ ok: true }); });

  app.get('/admin/gateway-keys', (c) => c.json(listGatewayKeys(db)));
  app.post('/admin/gateway-keys', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    return c.json(createGatewayKey(db, typeof b.name === 'string' ? b.name : 'key'), 201);
  });
  app.delete('/admin/gateway-keys/:id', (c) => { deleteGatewayKey(db, c.req.param('id')); return c.json({ ok: true }); });

  app.get('/admin/logs', (c) => {
    const q = c.req.query();
    return c.json(listLogs(db, { limit: q.limit ? Number(q.limit) : undefined, model: q.model, account: q.account, status: q.status }));
  });
  app.get('/admin/stats', (c) => {
    const since = c.req.query('sinceMs');
    return c.json(aggregateStats(db, since ? Number(since) : 0));
  });
  app.get('/admin/models', (c) => c.json(listPublicModels(db)));
```
> `updateAccount` ignores `undefined` fields, so a PATCH with only `{weight}` touches only weight.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/admin-data.test.ts` → 3 pass. Then **`bun test`** (whole suite green) and **`bunx tsc --noEmit`** clean.

- [ ] **Step 5: Commit**

```bash
git add src/ingress/admin-routes.ts tests/admin-data.test.ts
git commit -m "feat: admin data routes (accounts CRUD, gateway-keys, logs, stats, models)"
```

---

## Phase 3a Definition of Done

- `bun test` green; `bunx tsc --noEmit` clean.
- With `ADMIN_KEY` set, `POST /admin/login` issues an httpOnly SameSite=Strict HMAC cookie; every other `/admin/*` (except `GET /admin`) is 401 without it.
- Accounts: create (key encrypted), list-with-health (**no secret ever returned**), patch, delete, reset-cooldown — all over HTTP.
- Gateway-keys: create returns the raw key **once** (only its hash stored), list is masked, delete revokes (`verifyGatewayKey` then fails).
- Logs filter and stats aggregate (totals, error rate, by-model, by-account).
- Admin routes are inert when `ADMIN_KEY` is unset (no regression to `/v1/*` or existing tests).

---

## Phase 3b Preview (next plan — the console UI)

Each item TDD'd where testable; the page itself gets a served-HTML smoke test.

1. **Console page** (`src/ingress/admin-routes.ts` `GET /admin` → the real self-contained HTML, replacing the shell): inline CSS + vanilla JS, a login view + a shell with sidebar tabs, `fetch('/admin/*', {credentials:'same-origin'})`. Light/dark.
2. **Pool tab**: accounts table with status color-coding (healthy/cooling/exhausted/disabled), cooldown/errors, row actions (enable-disable via PATCH, reset-cooldown, edit, delete) + "add account" form (with key input).
3. **Logs tab**: request_logs table + model/account/status filters.
4. **Stats tab**: summary cards (requests / error-rate / tokens / est cost) + by-model / by-account tables (the dataviz skill informs any charts).
5. **Keys tab**: gateway-key list (masked) + create (surface the raw key once in a copy box) + revoke.
6. **Served-HTML smoke test** + a manual run checklist. (Heavier browser e2e stays deferred.)
