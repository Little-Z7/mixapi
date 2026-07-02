# mixapi Phase 1B-① — Pooling Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace 1A's single-account `selectAccountForModel` with a real account pool: a health state machine, a candidate query with time-based recovery, a pure sticky+weighted router, and a failover loop that transparently retries a different healthy account on retryable upstream errors.

**Architecture:** Four new pure-ish modules under `src/core/` (`health`, `pool`, `router`, `failover`) composed by a single `routeAndCall()` entry that the chat route calls in place of `selectAccountForModel` + `callUpstream`. Failover commits on response status (Option A): `callUpstream` already returns a stream only on `resp.ok && body`, so "got a stream or a non-error json" is the commit point; anything else retryable rotates to the next candidate. Recovery is time-based — the pool query re-admits accounts whose `cooldown_until` has passed; no scheduler.

**Tech Stack:** TypeScript · Bun (`bun test`, `bun:sqlite`) · Hono. Builds on Phase 1A (`main` @ `6a376fc`).

## Global Constraints

- Runtime **Bun**; all tests run with `bun test`; DB driver **`bun:sqlite`**.
- Upstream calls use the Fetch API with an **injectable `fetchFn`** so tests never hit the network. Selection randomness uses an **injectable `rng`** for deterministic tests.
- **Never log secrets or tokens** — no API keys / Authorization headers in any log line; strip `secretEnc` from any account object that leaves the pool layer.
- **No schema change** — reuse 1A's `account_state` (`status`, `cooldown_until`, `consecutive_errors`, `last_used_at`, `last_error`, `last_checked_at`).
- **Failover commits on response status** (a stream, or a non-error non-stream json); retryable-else-rotate; **non-retryable (`retryable=false`) stops immediately**.
- **Health never punishes non-account errors**: `reason ∈ {bad_request, unknown}` → no state change.
- **Recovery is time-based**: candidate query admits `cooldown_until IS NULL OR cooldown_until <= now`.
- Timestamps `Date.now()` (integer ms), ids `crypto.randomUUID()`. Follow **TDD**; frequent commits.

---

### Task 1: Health state machine (`core/health.ts`)

**Files:**
- Create: `src/core/health.ts`
- Test: `tests/health.test.ts`

**Interfaces:**
- Consumes: `ErrorClassification`, `ErrorReason` from `src/adapters/types.ts` (1A); `account_state` schema (1A); `insertAccount` from `src/data/accounts.ts` (test seeding).
- Produces:
  - `backoff(consecutiveErrors: number): number`
  - `applyError(db: Database, accountId: string, cls: ErrorClassification, now?: number): void`
  - `applySuccess(db: Database, accountId: string, now?: number): void`
  - constants `BACKOFF_BASE_MS`, `BACKOFF_CAP_MS`, `QUOTA_COOLDOWN_MS`

- [ ] **Step 1: Write the failing test**

`tests/health.test.ts`:
```ts
import { test, expect } from 'bun:test';
import { openDb, applySchema } from '../src/data/db';
import { insertAccount } from '../src/data/accounts';
import { applyError, applySuccess, backoff, BACKOFF_CAP_MS, QUOTA_COOLDOWN_MS } from '../src/core/health';

function seed() {
  const db = openDb(':memory:');
  applySchema(db);
  const id = insertAccount(db, {
    name: 'a', provider: 'glm', adapter: 'openai', baseUrl: 'https://x.test/v1',
    models: [{ public: 'm', target: 'm' }], weight: 1, egress: null, secretEnc: new Uint8Array([1]),
  });
  return { db, id };
}
function state(db: any, id: string) {
  return db.query('SELECT status,cooldown_until,consecutive_errors,last_error FROM account_state WHERE account_id=?').get(id);
}

test('rate_limit with cooldownMs -> cooling at now+cooldownMs', () => {
  const { db, id } = seed();
  applyError(db, id, { retryable: true, reason: 'rate_limit', cooldownMs: 12000 }, 1000);
  expect(state(db, id)).toMatchObject({ status: 'cooling', cooldown_until: 13000, consecutive_errors: 1, last_error: 'rate_limit' });
});

test('quota -> exhausted with long cooldown', () => {
  const { db, id } = seed();
  applyError(db, id, { retryable: true, reason: 'quota' }, 1000);
  expect(state(db, id)).toMatchObject({ status: 'exhausted', cooldown_until: 1000 + QUOTA_COOLDOWN_MS });
});

test('auth -> disabled, no cooldown', () => {
  const { db, id } = seed();
  applyError(db, id, { retryable: true, reason: 'auth' }, 1000);
  expect(state(db, id)).toMatchObject({ status: 'disabled', cooldown_until: null });
});

test('server -> cooling with backoff', () => {
  const { db, id } = seed();
  applyError(db, id, { retryable: true, reason: 'server' }, 1000);
  const s = state(db, id) as any;
  expect(s.status).toBe('cooling');
  expect(s.cooldown_until).toBe(1000 + backoff(1));
});

test('bad_request and unknown do not change state', () => {
  const { db, id } = seed();
  applyError(db, id, { retryable: false, reason: 'bad_request' }, 1000);
  applyError(db, id, { retryable: true, reason: 'unknown' }, 1000);
  expect(state(db, id)).toMatchObject({ status: 'unknown', consecutive_errors: 0 });
});

test('applySuccess resets to healthy', () => {
  const { db, id } = seed();
  applyError(db, id, { retryable: true, reason: 'server' }, 1000);
  applySuccess(db, id, 2000);
  expect(state(db, id)).toMatchObject({ status: 'healthy', consecutive_errors: 0, cooldown_until: null });
});

test('backoff grows and caps', () => {
  expect(backoff(1)).toBeLessThan(backoff(3));
  expect(backoff(100)).toBe(BACKOFF_CAP_MS);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/health.test.ts`
Expected: FAIL — module `../src/core/health` not found.

- [ ] **Step 3: Write minimal implementation**

`src/core/health.ts`:
```ts
import type { Database } from 'bun:sqlite';
import type { ErrorClassification } from '../adapters/types';

export const BACKOFF_BASE_MS = 5000;
export const BACKOFF_CAP_MS = 300000;
export const QUOTA_COOLDOWN_MS = 3600000;

export function backoff(consecutiveErrors: number): number {
  const exp = Math.min(Math.max(consecutiveErrors, 0), 6);
  return Math.min(BACKOFF_BASE_MS * 2 ** exp, BACKOFF_CAP_MS);
}

export function applyError(
  db: Database, accountId: string, cls: ErrorClassification, now: number = Date.now()
): void {
  if (cls.reason === 'bad_request' || cls.reason === 'unknown') return; // not the account's fault

  const row = db.query('SELECT consecutive_errors FROM account_state WHERE account_id = ?')
    .get(accountId) as { consecutive_errors: number } | null;
  const n = (row?.consecutive_errors ?? 0) + 1;

  let status: string;
  let cooldownUntil: number | null;
  if (cls.reason === 'rate_limit') { status = 'cooling'; cooldownUntil = now + (cls.cooldownMs ?? backoff(n)); }
  else if (cls.reason === 'quota') { status = 'exhausted'; cooldownUntil = now + QUOTA_COOLDOWN_MS; }
  else if (cls.reason === 'auth') { status = 'disabled'; cooldownUntil = null; }
  else { status = 'cooling'; cooldownUntil = now + backoff(n); } // 'server'

  db.query(
    `UPDATE account_state SET status=?, cooldown_until=?, consecutive_errors=?, last_error=?, last_checked_at=?
     WHERE account_id=?`
  ).run(status, cooldownUntil, n, cls.reason, now, accountId);
}

export function applySuccess(db: Database, accountId: string, now: number = Date.now()): void {
  db.query(
    `UPDATE account_state SET status='healthy', consecutive_errors=0, cooldown_until=NULL, last_used_at=?, last_checked_at=?
     WHERE account_id=?`
  ).run(now, now, accountId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/health.test.ts`
Expected: 7 pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/health.ts tests/health.test.ts
git commit -m "feat: account health state machine"
```

---

### Task 2: Candidate pool query (`core/pool.ts`)

**Files:**
- Create: `src/core/pool.ts`
- Test: `tests/pool.test.ts`

**Interfaces:**
- Consumes: `ResolvedAccount`, `ModelMap` from `src/data/accounts.ts` (1A); `accounts`/`credentials`/`account_state` schema (1A).
- Produces:
  - `interface Candidate extends ResolvedAccount { secretEnc: Uint8Array; status: string }`
  - `listCandidates(db: Database, publicModel: string, now?: number): Candidate[]`

- [ ] **Step 1: Write the failing test**

`tests/pool.test.ts`:
```ts
import { test, expect } from 'bun:test';
import { openDb, applySchema } from '../src/data/db';
import { insertAccount } from '../src/data/accounts';
import { listCandidates } from '../src/core/pool';

function db2() { const d = openDb(':memory:'); applySchema(d); return d; }
function add(db: any, name: string, model: string) {
  return insertAccount(db, {
    name, provider: 'glm', adapter: 'openai', baseUrl: 'https://x.test/v1',
    models: [{ public: model, target: model }], weight: 1, egress: null, secretEnc: new Uint8Array([1]),
  });
}
function setState(db: any, id: string, status: string, cooldown: number | null) {
  db.query('UPDATE account_state SET status=?, cooldown_until=? WHERE account_id=?').run(status, cooldown, id);
}

test('lists enabled accounts serving the model', () => {
  const db = db2();
  add(db, 'a', 'gpt'); add(db, 'b', 'gpt'); add(db, 'c', 'other');
  const got = listCandidates(db, 'gpt').map((c) => c.name).sort();
  expect(got).toEqual(['a', 'b']);
});

test('excludes disabled', () => {
  const db = db2();
  const a = add(db, 'a', 'gpt'); add(db, 'b', 'gpt');
  setState(db, a, 'disabled', null);
  expect(listCandidates(db, 'gpt').map((c) => c.name)).toEqual(['b']);
});

test('cooling account re-admitted after cooldown passes', () => {
  const db = db2();
  const a = add(db, 'a', 'gpt');
  setState(db, a, 'cooling', 5000);
  expect(listCandidates(db, 'gpt', 4000)).toEqual([]);      // still cooling
  expect(listCandidates(db, 'gpt', 6000).map((c) => c.name)).toEqual(['a']); // cooldown passed
});

test('candidate carries secretEnc and status', () => {
  const db = db2();
  add(db, 'a', 'gpt');
  const c = listCandidates(db, 'gpt')[0];
  expect(Array.from(c.secretEnc)).toEqual([1]);
  expect(c.status).toBe('unknown');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/pool.test.ts`
Expected: FAIL — module `../src/core/pool` not found.

- [ ] **Step 3: Write minimal implementation**

`src/core/pool.ts`:
```ts
import type { Database } from 'bun:sqlite';
import type { ResolvedAccount, ModelMap } from '../data/accounts';

export interface Candidate extends ResolvedAccount {
  secretEnc: Uint8Array;
  status: string;
}

interface Row {
  id: string; name: string; provider: string; adapter: string;
  base_url: string; models: string; weight: number; egress: string | null;
  secret_enc: Uint8Array; status: string | null;
}

export function listCandidates(db: Database, publicModel: string, now: number = Date.now()): Candidate[] {
  const rows = db.query(
    `SELECT a.id,a.name,a.provider,a.adapter,a.base_url,a.models,a.weight,a.egress,
            c.secret_enc AS secret_enc, s.status AS status
     FROM accounts a
     JOIN credentials c ON c.account_id = a.id
     LEFT JOIN account_state s ON s.account_id = a.id
     WHERE a.enabled = 1
       AND COALESCE(s.status, 'unknown') != 'disabled'
       AND (s.cooldown_until IS NULL OR s.cooldown_until <= ?)`
  ).all(now) as Row[];
  return rows
    .map((r) => ({
      id: r.id, name: r.name, provider: r.provider, adapter: r.adapter,
      baseUrl: r.base_url, models: JSON.parse(r.models) as ModelMap[],
      weight: r.weight, egress: r.egress, secretEnc: r.secret_enc, status: r.status ?? 'unknown',
    }))
    .filter((c) => c.models.some((m) => m.public === publicModel));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/pool.test.ts`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/pool.ts tests/pool.test.ts
git commit -m "feat: candidate pool query with time-based recovery"
```

---

### Task 3: Router — sticky + weighted selection (`core/router.ts`)

**Files:**
- Create: `src/core/router.ts`
- Test: `tests/router.test.ts`

**Interfaces:**
- Consumes: `Candidate` from `src/core/pool.ts` (Task 2).
- Produces:
  - `interface SelectOpts { sessionId?: string; exclude?: Set<string>; rng?: () => number }`
  - `selectCandidate(candidates: Candidate[], opts?: SelectOpts): Candidate | null`

A `Candidate` for tests only needs `{ id, weight }` plus filler fields; construct minimal objects cast to `Candidate`.

- [ ] **Step 1: Write the failing test**

`tests/router.test.ts`:
```ts
import { test, expect } from 'bun:test';
import { selectCandidate } from '../src/core/router';
import type { Candidate } from '../src/core/pool';

function cand(id: string, weight = 1): Candidate {
  return { id, name: id, provider: 'p', adapter: 'openai', baseUrl: '', models: [], weight,
    egress: null, secretEnc: new Uint8Array(), status: 'healthy' };
}

test('empty -> null', () => {
  expect(selectCandidate([])).toBeNull();
});

test('exclude removes tried, then null when all excluded', () => {
  const pool = [cand('a'), cand('b')];
  const picked = selectCandidate(pool, { exclude: new Set(['a']), rng: () => 0 });
  expect(picked?.id).toBe('b');
  expect(selectCandidate(pool, { exclude: new Set(['a', 'b']) })).toBeNull();
});

test('sessionId is sticky (same session -> same account)', () => {
  const pool = [cand('a'), cand('b'), cand('c')];
  const first = selectCandidate(pool, { sessionId: 'sess-42' })!.id;
  const again = selectCandidate(pool, { sessionId: 'sess-42' })!.id;
  expect(again).toBe(first);
});

test('weighted random honors injected rng', () => {
  const pool = [cand('a', 1), cand('b', 1)];
  expect(selectCandidate(pool, { rng: () => 0 })!.id).toBe('a');   // first band
  expect(selectCandidate(pool, { rng: () => 0.99 })!.id).toBe('b'); // last band
});

test('higher weight wins a mid-range draw', () => {
  const pool = [cand('a', 1), cand('b', 9)]; // total 10; draw at 0.5 -> 5 -> lands in b
  expect(selectCandidate(pool, { rng: () => 0.5 })!.id).toBe('b');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/router.test.ts`
Expected: FAIL — module `../src/core/router` not found.

- [ ] **Step 3: Write minimal implementation**

`src/core/router.ts`:
```ts
import type { Candidate } from './pool';

// FNV-1a 32-bit, stable across runs
function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface SelectOpts {
  sessionId?: string;
  exclude?: Set<string>;
  rng?: () => number;
}

export function selectCandidate(candidates: Candidate[], opts: SelectOpts = {}): Candidate | null {
  const pool = opts.exclude ? candidates.filter((c) => !opts.exclude!.has(c.id)) : candidates;
  if (pool.length === 0) return null;

  if (opts.sessionId) {
    return pool[hashStr(opts.sessionId) % pool.length];
  }

  const rng = opts.rng ?? Math.random;
  const weights = pool.map((c) => Math.max(1, c.weight));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r < 0) return pool[i];
  }
  return pool[pool.length - 1]; // float-rounding fallback
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/router.test.ts`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/router.ts tests/router.test.ts
git commit -m "feat: sticky + weighted candidate router"
```

---

### Task 4: Failover loop (`core/failover.ts`)

**Files:**
- Create: `src/core/failover.ts`
- Test: `tests/failover.test.ts`

**Interfaces:**
- Consumes: `listCandidates` (Task 2), `selectCandidate` (Task 3), `applyError`/`applySuccess` (Task 1), `StaticKeyCredential` (1A `src/credentials/static-key.ts`), `getAdapter` (1A `src/adapters/registry.ts`), `callUpstream` + `UpstreamResult` (1A `src/core/upstream.ts`), `ChatRequest`/`ErrorReason` (1A `src/adapters/types.ts`), `ResolvedAccount` (1A).
- Produces:
  - `interface RouteOutcome { ok: boolean; result?: UpstreamResult; account?: ResolvedAccount; attempts: number; lastError?: { httpStatus: number; reason: ErrorReason }; noCandidates?: boolean }`
  - `interface RouteOpts { fetchFn?: typeof fetch; sessionId?: string; maxAttempts?: number; rng?: () => number }`
  - `routeAndCall(db: Database, req: ChatRequest, masterKeyHex: string, opts?: RouteOpts): Promise<RouteOutcome>`

- [ ] **Step 1: Write the failing test**

`tests/failover.test.ts`:
```ts
import { test, expect } from 'bun:test';
import { openDb, applySchema } from '../src/data/db';
import { insertAccount } from '../src/data/accounts';
import { encryptSecret } from '../src/credentials/crypto';
import { routeAndCall } from '../src/core/failover';
import type { ChatRequest } from '../src/adapters/types';

const KEY = 'a'.repeat(64);
function setup(n: number) {
  const db = openDb(':memory:'); applySchema(db);
  for (let i = 0; i < n; i++) {
    insertAccount(db, {
      name: `a${i}`, provider: 'glm', adapter: 'openai', baseUrl: 'https://x.test/v1',
      models: [{ public: 'm', target: 'm' }], weight: 1, egress: null, secretEnc: encryptSecret('sk', KEY),
    });
  }
  return db;
}
const REQ: ChatRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false };

test('first candidate 429 -> fails over to a healthy one', async () => {
  const db = setup(2);
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    return calls === 1
      ? new Response(JSON.stringify({ error: 'rl' }), { status: 429 })
      : new Response(JSON.stringify({ ok: 1 }), { status: 200 });
  }) as unknown as typeof fetch;
  const out = await routeAndCall(db, REQ, KEY, { fetchFn, rng: () => 0 });
  expect(out.ok).toBe(true);
  expect(out.attempts).toBe(2);
  expect((out.result!.json as any).ok).toBe(1);
});

test('network throw on a candidate rotates to the next', async () => {
  const db = setup(2);
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    if (calls === 1) throw new Error('ECONNREFUSED');
    return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
  }) as unknown as typeof fetch;
  const out = await routeAndCall(db, REQ, KEY, { fetchFn, rng: () => 0 });
  expect(out.ok).toBe(true);
  expect(out.attempts).toBe(2);
});

test('non-retryable 400 stops immediately (no failover)', async () => {
  const db = setup(2);
  const fetchFn = (async () => new Response(JSON.stringify({ e: 1 }), { status: 400 })) as unknown as typeof fetch;
  const out = await routeAndCall(db, REQ, KEY, { fetchFn, rng: () => 0 });
  expect(out.ok).toBe(false);
  expect(out.attempts).toBe(1);
  expect(out.lastError).toMatchObject({ httpStatus: 400, reason: 'bad_request' });
});

test('no account serving model -> noCandidates', async () => {
  const db = setup(1);
  const out = await routeAndCall(db, { ...REQ, model: 'missing' }, KEY,
    { fetchFn: (async () => new Response('{}')) as unknown as typeof fetch });
  expect(out).toMatchObject({ ok: false, noCandidates: true, attempts: 0 });
});

test('streaming: first 429 -> next returns a stream, committed', async () => {
  const db = setup(2);
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ error: 'rl' }), { status: 429 });
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('data: hi\n\n')); c.close(); } });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  const out = await routeAndCall(db, { ...REQ, stream: true }, KEY, { fetchFn, rng: () => 0 });
  expect(out.ok).toBe(true);
  expect(out.result!.stream).toBeDefined();
  expect(out.attempts).toBe(2);
});

test('applies cooling to the failed account', async () => {
  const db = setup(2);
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    return calls === 1
      ? new Response(JSON.stringify({}), { status: 429 })
      : new Response(JSON.stringify({ ok: 1 }), { status: 200 });
  }) as unknown as typeof fetch;
  await routeAndCall(db, REQ, KEY, { fetchFn, sessionId: 'fixed' }); // deterministic first pick via stickiness
  const statuses = db.query('SELECT status FROM account_state').all().map((r: any) => r.status).sort();
  expect(statuses).toContain('cooling'); // the 429'd account is cooling
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/failover.test.ts`
Expected: FAIL — module `../src/core/failover` not found.

- [ ] **Step 3: Write minimal implementation**

`src/core/failover.ts`:
```ts
import type { Database } from 'bun:sqlite';
import type { ChatRequest, ErrorReason } from '../adapters/types';
import type { ResolvedAccount } from '../data/accounts';
import { listCandidates } from './pool';
import { selectCandidate } from './router';
import { applyError, applySuccess } from './health';
import { StaticKeyCredential } from '../credentials/static-key';
import { getAdapter } from '../adapters/registry';
import { callUpstream, type UpstreamResult } from './upstream';

export interface RouteOutcome {
  ok: boolean;
  result?: UpstreamResult;
  account?: ResolvedAccount;
  attempts: number;
  lastError?: { httpStatus: number; reason: ErrorReason };
  noCandidates?: boolean;
}

export interface RouteOpts {
  fetchFn?: typeof fetch;
  sessionId?: string;
  maxAttempts?: number;
  rng?: () => number;
}

export async function routeAndCall(
  db: Database, req: ChatRequest, masterKeyHex: string, opts: RouteOpts = {}
): Promise<RouteOutcome> {
  const fetchFn = opts.fetchFn ?? fetch;
  const maxAttempts = opts.maxAttempts ?? 3;
  const candidates = listCandidates(db, req.model);
  if (candidates.length === 0) return { ok: false, attempts: 0, noCandidates: true };

  const tried = new Set<string>();
  let attempts = 0;
  let lastError: { httpStatus: number; reason: ErrorReason } | undefined;

  while (attempts < maxAttempts) {
    const cand = selectCandidate(candidates, { sessionId: opts.sessionId, exclude: tried, rng: opts.rng });
    if (!cand) break;
    tried.add(cand.id);
    attempts++;

    const { secretEnc, status, ...account } = cand; // strip pool-only fields
    const adapter = getAdapter(cand.adapter);
    let result: UpstreamResult;
    try {
      const apiKey = await new StaticKeyCredential(cand.secretEnc, masterKeyHex).getApiKey();
      const u = adapter.buildRequest(req, account, apiKey);
      result = await callUpstream(u, req.stream, fetchFn);
    } catch {
      applyError(db, cand.id, { retryable: true, reason: 'server' });
      lastError = { httpStatus: 502, reason: 'server' };
      continue;
    }

    if (result.stream || result.status < 400) {
      applySuccess(db, cand.id);
      return { ok: true, result, account, attempts };
    }

    const cls = adapter.classifyError(result.status, result.json, result.headers);
    applyError(db, cand.id, cls);
    lastError = { httpStatus: result.status, reason: cls.reason };
    if (!cls.retryable) break;
  }

  return { ok: false, attempts, lastError };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/failover.test.ts`
Expected: 6 pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/failover.ts tests/failover.test.ts
git commit -m "feat: pooling failover loop (routeAndCall)"
```

---

### Task 5: Wire failover into the chat route (`ingress/openai-routes.ts`)

**Files:**
- Modify: `src/ingress/openai-routes.ts` (replace the chat handler's selection + single-call logic with `routeAndCall`)
- Modify: `tests/chat.test.ts` (append pooling integration tests; keep all existing tests)

**Interfaces:**
- Consumes: `routeAndCall`/`RouteOutcome` (Task 4), `getAdapter` (1A, for `parseResponse`), `listPublicModels` (1A), `verifyGatewayKey` (1A), `logRequest`/`estimateCost` (1A), `ChatRequest` (1A).
- Produces: unchanged public surface (`buildApp(deps?)`, `/v1/models`, `/v1/chat/completions`). The route no longer imports `selectAccountForModel` or `callUpstream` (both now live behind `routeAndCall`). `src/core/select.ts` and its test are left in place (no longer used by the route).

- [ ] **Step 1: Write the failing tests (append to `tests/chat.test.ts`)**

Append these; do NOT remove existing tests:
```ts
test('pool: first account 429 -> transparently served by second, attempt_count=2', async () => {
  const db = openDb(':memory:'); applySchema(db); seedGatewayKey(db, 'gw');
  for (const n of ['a', 'b']) {
    insertAccount(db, {
      name: n, provider: 'glm', adapter: 'openai', baseUrl: 'https://up.test/v1',
      models: [{ public: 'glm-4.6', target: 'glm-real' }], weight: 1, egress: null,
      secretEnc: encryptSecret('sk-up', KEY),
    });
  }
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    return calls === 1
      ? new Response(JSON.stringify({ error: 'rl' }), { status: 429 })
      : new Response(JSON.stringify({ id: 'x', choices: [{ message: { role: 'assistant', content: 'hi' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const app = buildApp({ db, masterKeyHex: KEY, fetchFn });
  const res = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer gw', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-4.6', messages: [{ role: 'user', content: 'hey' }] }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).choices[0].message.content).toBe('hi');
  const log = db.query('SELECT attempt_count FROM request_logs ORDER BY ts DESC LIMIT 1').get() as any;
  expect(log.attempt_count).toBe(2);
});
```
(This test reuses `KEY`, `openDb`, `applySchema`, `insertAccount`, `encryptSecret`, `seedGatewayKey`, `buildApp` — all already imported at the top of `tests/chat.test.ts` from Phase 1A. If `openDb`/`applySchema`/`insertAccount`/`encryptSecret` are not yet imported there, add the imports.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/chat.test.ts`
Expected: FAIL — new test fails (route still uses single-account `selectAccountForModel`, so a 429 on the first account returns an error instead of failing over; `attempt_count` is 1, not 2).

- [ ] **Step 3: Rewrite `src/ingress/openai-routes.ts`**

Replace the entire file with:
```ts
import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import { verifyGatewayKey } from './auth';
import { routeAndCall } from '../core/failover';
import { getAdapter } from '../adapters/registry';
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
    let req: Partial<ChatRequest>;
    try { req = (await c.req.json()) as Partial<ChatRequest>; }
    catch { return c.json({ error: { message: 'invalid JSON body', type: 'bad_request' } }, 400); }
    if (!req.model) return c.json({ error: { message: 'model required', type: 'bad_request' } }, 400);
    const stream = req.stream === true;
    const chatReq: ChatRequest = { messages: [], ...req, model: req.model, stream } as ChatRequest;
    const sessionId = c.req.header('x-session-id');

    const outcome = await routeAndCall(db, chatReq, masterKeyHex, { fetchFn, sessionId });

    if (outcome.noCandidates) {
      logRequest(db, { publicModel: req.model, status: 'error', httpStatus: 404, stream, attemptCount: 0 });
      return c.json({ error: { message: `no account serves model ${req.model}`, type: 'not_found' } }, 404);
    }

    if (!outcome.ok || !outcome.result) {
      const httpStatus = outcome.lastError?.httpStatus ?? 502;
      // network / 5xx surfaces as bad_gateway; a passed-through 4xx keeps its reason
      const type = httpStatus >= 500 ? 'bad_gateway' : (outcome.lastError?.reason ?? 'server');
      logRequest(db, {
        publicModel: req.model, accountId: outcome.account?.id ?? null, status: 'error',
        httpStatus, latencyMs: Date.now() - started, stream, attemptCount: outcome.attempts,
      });
      return c.json({ error: { message: `upstream error (${type})`, type } }, httpStatus as any);
    }

    const result = outcome.result;
    const account = outcome.account!;

    if (stream && result.stream) {
      logRequest(db, {
        publicModel: req.model, accountId: account.id, status: 'ok', httpStatus: 200,
        latencyMs: Date.now() - started, stream: true, attemptCount: outcome.attempts,
      });
      return new Response(result.stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
      });
    }

    if (stream && !result.stream) {
      logRequest(db, {
        publicModel: req.model, accountId: account.id, status: 'error', httpStatus: 502,
        latencyMs: Date.now() - started, stream, attemptCount: outcome.attempts,
      });
      return c.json({ error: { message: 'upstream returned no stream body', type: 'bad_gateway' } }, 502);
    }

    const parsed = getAdapter(account.adapter).parseResponse(result.status, result.json) as any;
    const usage = parsed?.usage ?? {};
    logRequest(db, {
      publicModel: req.model, accountId: account.id, status: 'ok', httpStatus: result.status,
      latencyMs: Date.now() - started,
      promptTokens: usage.prompt_tokens ?? null, completionTokens: usage.completion_tokens ?? null,
      totalTokens: usage.total_tokens ?? null,
      estCost: estimateCost(req.model, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0),
      attemptCount: outcome.attempts, stream: false,
    });
    return c.json(parsed, result.status as any);
  });
}
```

- [ ] **Step 4: Run the full suite**

Run: `bun test`
Expected: all suites pass — the existing 1A chat tests (401 / models / non-stream proxy+log / stream passthrough / 404 / bodyless-2xx→502 / network→502 / malformed→400) still pass now via `routeAndCall`, plus the new pooling failover test. Then run `bunx tsc --noEmit` — expected clean.

- [ ] **Step 5: Commit**

```bash
git add src/ingress/openai-routes.ts tests/chat.test.ts
git commit -m "feat: route chat through pooling failover (routeAndCall)"
```

---

## Phase 1B-① Definition of Done

- `bun test` green across all suites; `bunx tsc --noEmit` clean.
- Pool of ≥2 accounts serving one model; a retryable upstream error on the chosen account transparently fails over to another, and `request_logs.attempt_count` reflects the retry count.
- A rate-limited / errored account enters `cooling` (or `exhausted`/`disabled`) and is excluded from candidates until `cooldown_until` passes, then re-admitted; a subsequent success returns it to `healthy`.
- Same `x-session-id` sticks to the same account while healthy.
- Non-retryable (400) does not fail over; no candidates → 404; all candidates failing → error with the last upstream status (or 502 for network).
- No secret ever logged; `secretEnc` never leaves the pool/failover layer on a returned account.

## Deferred to 1B-② (next plan)

Anthropic adapter (+ `registry.ts` owning the REGISTRY map to serve multiple adapters), `config.yaml` bootstrap (declare the multi-account pool so this is end-to-end operable), admin REST (CRUD + health view), and the mock-upstream acceptance suite — plus the carried-over fix-in-1B items (credentials.account_id UNIQUE+FK, `typecheck` script, Retry-After NaN guard, permanent-4xx non-retry) tracked in `.superpowers/sdd/progress.md`.
