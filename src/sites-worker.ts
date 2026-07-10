import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import consoleHtml from './admin/console.html' with { type: 'text' };
import { getAdapter } from './adapters/registry';
import type { ChatRequest, ErrorClassification, ErrorReason, ProviderAdapter } from './adapters/types';
import type { ResolvedAccount, ModelMap } from './data/accounts';
import { deriveStickyKey } from './core/sticky';
import { selectCandidate } from './core/router';
import { callUpstream, type UpstreamResult } from './core/upstream';
import { estimateCost } from './usage/cost';
import { joinPath } from './adapters/types';

interface D1Result<T = Record<string, unknown>> { results?: T[]; success: boolean }
interface D1Prepared {
  bind(...values: unknown[]): D1Prepared;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}
interface D1Database {
  prepare(sql: string): D1Prepared;
  batch<T = Record<string, unknown>>(statements: D1Prepared[]): Promise<D1Result<T>[]>;
}
interface Env { DB: D1Database; MASTER_KEY: string; ADMIN_KEY?: string; GATEWAY_KEY?: string }

type Bind = string | number | ArrayBuffer | Uint8Array | null;
const enc = new TextEncoder();
const dec = new TextDecoder();
const COOKIE = 'mixadmin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const BACKOFF_BASE_MS = 5000;
const BACKOFF_CAP_MS = 300000;
const QUOTA_COOLDOWN_MS = 3600000;

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return new Uint8Array(value as number[]);
  if (value && typeof value === 'object' && 'buffer' in value) return new Uint8Array((value as { buffer: ArrayBuffer }).buffer);
  throw new Error('invalid encrypted credential');
}

function hex(value: Uint8Array): string {
  return [...value].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error('MASTER_KEY must be 64 hex chars (32 bytes)');
  return new Uint8Array(value.match(/../g)!.map((part) => parseInt(part, 16)));
}

function webBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(value);
}

async function sha256(value: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(value))));
}

async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(value))));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function encryptSecret(value: string, masterKey: string): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', webBytes(fromHex(masterKey)), 'AES-GCM', false, ['encrypt']);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: webBytes(iv) }, key, enc.encode(value)));
  const ciphertext = encrypted.subarray(0, encrypted.length - 16);
  const tag = encrypted.subarray(encrypted.length - 16);
  const out = new Uint8Array(iv.length + tag.length + ciphertext.length);
  out.set(iv, 0); out.set(tag, 12); out.set(ciphertext, 28);
  return out;
}

async function decryptSecret(value: Uint8Array, masterKey: string): Promise<string> {
  const iv = value.subarray(0, 12), tag = value.subarray(12, 28), ciphertext = value.subarray(28);
  const input = new Uint8Array(ciphertext.length + tag.length);
  input.set(ciphertext, 0); input.set(tag, ciphertext.length);
  const key = await crypto.subtle.importKey('raw', webBytes(fromHex(masterKey)), 'AES-GCM', false, ['decrypt']);
  return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: webBytes(iv) }, key, webBytes(input)));
}

async function signSession(adminKey: string, now = Date.now()): Promise<string> {
  const exp = String(now + SESSION_TTL_MS);
  return `${exp}.${await hmac(exp, await sha256('session:' + adminKey))}`;
}

async function verifySession(adminKey: string, token?: string): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const exp = token.slice(0, dot), mac = token.slice(dot + 1);
  if (!Number.isFinite(Number(exp)) || Number(exp) <= Date.now()) return false;
  return constantTimeEqual(mac, await hmac(exp, await sha256('session:' + adminKey)));
}

async function ensureBootstrap(env: Env): Promise<void> {
  if (!env.MASTER_KEY || !/^[0-9a-f]{64}$/i.test(env.MASTER_KEY)) throw new Error('MASTER_KEY is not configured');
  if (!env.GATEWAY_KEY) return;
  const keyHash = await sha256(env.GATEWAY_KEY);
  const existing = await env.DB.prepare('SELECT id FROM gateway_keys WHERE key_hash=?').bind(keyHash).first();
  if (!existing) {
    await env.DB.prepare('INSERT INTO gateway_keys (id,key_hash,name,enabled,created_at) VALUES (?,?,?,?,?)')
      .bind(crypto.randomUUID(), keyHash, 'bootstrap', 1, Date.now()).run();
  }
}

async function resolveGatewayKeyId(db: D1Database, header?: string): Promise<string | null> {
  if (!header?.startsWith('Bearer ')) return null;
  const raw = header.slice(7).trim();
  if (!raw) return null;
  const row = await db.prepare('SELECT id,enabled FROM gateway_keys WHERE key_hash=?').bind(await sha256(raw))
    .first<{ id: string; enabled: number }>();
  return row?.enabled === 1 ? row.id : null;
}

interface AccountRow {
  id: string; name: string; provider: string; adapter: string; base_url: string;
  models: string; weight: number; egress: string | null;
}
interface Candidate extends ResolvedAccount { secretEnc: Uint8Array; status: string }

function accountFromRow(row: AccountRow): ResolvedAccount {
  return { id: row.id, name: row.name, provider: row.provider, adapter: row.adapter,
    baseUrl: row.base_url, models: JSON.parse(row.models), weight: row.weight, egress: row.egress };
}

async function listCandidates(db: D1Database, model: string, adapter?: string): Promise<Candidate[]> {
  const result = await db.prepare(`SELECT a.id,a.name,a.provider,a.adapter,a.base_url,a.models,a.weight,a.egress,
    c.secret_enc,s.status FROM accounts a JOIN credentials c ON c.account_id=a.id
    LEFT JOIN account_state s ON s.account_id=a.id WHERE a.enabled=1
    AND COALESCE(s.status,'unknown')!='disabled' AND (s.cooldown_until IS NULL OR s.cooldown_until<=?)
    AND (? IS NULL OR a.adapter=?)`).bind(Date.now(), adapter ?? null, adapter ?? null).all<AccountRow & { secret_enc: unknown; status: string | null }>();
  return (result.results ?? []).map((row) => ({ ...accountFromRow(row), secretEnc: bytes(row.secret_enc), status: row.status ?? 'unknown' }))
    .filter((account) => account.models.some((entry) => entry.public === model));
}

function backoff(errors: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.min(Math.max(errors, 0), 6), BACKOFF_CAP_MS);
}

async function applyError(db: D1Database, accountId: string, cls: ErrorClassification): Promise<void> {
  if (cls.reason === 'bad_request' || cls.reason === 'unknown') return;
  const row = await db.prepare('SELECT consecutive_errors FROM account_state WHERE account_id=?').bind(accountId)
    .first<{ consecutive_errors: number }>();
  const count = (row?.consecutive_errors ?? 0) + 1, now = Date.now();
  let status = 'cooling', cooldown: number | null = now + backoff(count);
  if (cls.reason === 'rate_limit') cooldown = now + (cls.cooldownMs ?? backoff(count));
  else if (cls.reason === 'quota') { status = 'exhausted'; cooldown = now + QUOTA_COOLDOWN_MS; }
  else if (cls.reason === 'auth') { status = 'disabled'; cooldown = null; }
  await db.prepare(`UPDATE account_state SET status=?,cooldown_until=?,consecutive_errors=?,last_error=?,last_checked_at=? WHERE account_id=?`)
    .bind(status, cooldown, count, cls.reason, now, accountId).run();
}

async function applySuccess(db: D1Database, accountId: string): Promise<void> {
  const now = Date.now();
  await db.prepare(`UPDATE account_state SET status='healthy',consecutive_errors=0,cooldown_until=NULL,last_used_at=?,last_checked_at=? WHERE account_id=?`)
    .bind(now, now, accountId).run();
}

interface RouteOutcome {
  ok: boolean; result?: UpstreamResult; account?: ResolvedAccount; attempts: number;
  lastError?: { httpStatus: number; reason: ErrorReason }; noCandidates?: boolean;
}

async function routeAndCall(db: D1Database, req: ChatRequest, masterKey: string, opts: {
  sessionId?: string; adapter?: string; maxAttempts?: number;
} = {}): Promise<RouteOutcome> {
  const candidates = await listCandidates(db, req.model, opts.adapter);
  if (!candidates.length) return { ok: false, attempts: 0, noCandidates: true };
  const tried = new Set<string>(); let attempts = 0;
  let lastError: RouteOutcome['lastError'], lastAccount: ResolvedAccount | undefined;
  while (attempts < (opts.maxAttempts ?? 3)) {
    const candidate = selectCandidate(candidates, { sessionId: opts.sessionId, exclude: tried });
    if (!candidate) break;
    tried.add(candidate.id); attempts++;
    const { secretEnc, status: _status, ...account } = candidate;
    lastAccount = account;
    let adapter: ProviderAdapter, result: UpstreamResult;
    try {
      adapter = getAdapter(candidate.adapter);
      const apiKey = await decryptSecret(secretEnc, masterKey);
      result = await callUpstream(adapter.buildRequest(req, account, apiKey), req.stream);
    } catch {
      await applyError(db, candidate.id, { retryable: true, reason: 'server' });
      lastError = { httpStatus: 502, reason: 'server' }; continue;
    }
    if ((req.stream && result.stream) || (!req.stream && result.status < 400)) {
      await applySuccess(db, candidate.id); return { ok: true, result, account, attempts };
    }
    if (result.status < 400) {
      await applyError(db, candidate.id, { retryable: true, reason: 'server' });
      lastError = { httpStatus: 502, reason: 'server' }; continue;
    }
    const cls = adapter.classifyError(result.status, result.json, result.headers);
    await applyError(db, candidate.id, cls); lastError = { httpStatus: result.status, reason: cls.reason };
    if (!cls.retryable) break;
  }
  return { ok: false, attempts, lastError, account: lastAccount };
}

interface RequestLog {
  gatewayKeyId?: string | null; publicModel?: string | null; accountId?: string | null;
  status: 'ok' | 'error' | 'failover'; httpStatus?: number | null; latencyMs?: number | null;
  promptTokens?: number | null; completionTokens?: number | null; totalTokens?: number | null;
  estCost?: number | null; attemptCount?: number | null; stream?: boolean; clientIp?: string | null;
}

async function logRequest(db: D1Database, entry: RequestLog): Promise<void> {
  await db.prepare(`INSERT INTO request_logs (id,ts,gateway_key_id,public_model,account_id,status,http_status,latency_ms,
    prompt_tokens,completion_tokens,total_tokens,est_cost,attempt_count,stream,client_ip) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(crypto.randomUUID(), Date.now(), entry.gatewayKeyId ?? null, entry.publicModel ?? null, entry.accountId ?? null,
      entry.status, entry.httpStatus ?? null, entry.latencyMs ?? null, entry.promptTokens ?? null,
      entry.completionTokens ?? null, entry.totalTokens ?? null, entry.estCost ?? null,
      entry.attemptCount ?? null, entry.stream ? 1 : 0, entry.clientIp ?? null).run();
}

async function publicModels(db: D1Database): Promise<string[]> {
  const result = await db.prepare('SELECT models FROM accounts WHERE enabled=1').all<{ models: string }>();
  const models = new Set<string>();
  for (const row of result.results ?? []) for (const entry of JSON.parse(row.models) as ModelMap[]) models.add(entry.public);
  return [...models];
}

function anthropicError(type: string, message: string) { return { type: 'error', error: { type, message } }; }

const app = new Hono<{ Bindings: Env; Variables: { gatewayKeyId?: string } }>();

app.onError((error, c) => {
  console.error(error);
  return c.json({ error: { message: 'internal server error', type: 'server' } }, 500);
});

app.use('*', async (c, next) => { await ensureBootstrap(c.env); await next(); });
app.get('/', (c) => c.redirect('/admin'));
app.get('/healthz', (c) => c.json({ status: 'ok', runtime: 'sites' }));

app.use('/v1/*', async (c, next) => {
  const id = await resolveGatewayKeyId(c.env.DB, c.req.header('authorization'));
  if (!id) return c.json({ error: { message: 'invalid gateway key', type: 'auth' } }, 401);
  c.set('gatewayKeyId', id); await next();
});

app.get('/v1/models', async (c) => c.json({ object: 'list', data: (await publicModels(c.env.DB)).map((id) => ({ id, object: 'model', owned_by: 'mixapi' })) }));

app.post('/v1/chat/completions', async (c) => {
  const started = Date.now(), gatewayKeyId = c.get('gatewayKeyId') ?? null;
  let input: Partial<ChatRequest>;
  try { input = await c.req.json(); } catch { return c.json({ error: { message: 'invalid JSON body', type: 'bad_request' } }, 400); }
  if (!input.model) return c.json({ error: { message: 'model required', type: 'bad_request' } }, 400);
  const stream = input.stream === true;
  const req = { messages: [], ...input, model: input.model, stream } as ChatRequest;
  const outcome = await routeAndCall(c.env.DB, req, c.env.MASTER_KEY, { sessionId: c.req.header('x-session-id') ?? deriveStickyKey(req), adapter: 'openai' });
  if (outcome.noCandidates) {
    await logRequest(c.env.DB, { gatewayKeyId, publicModel: input.model, status: 'error', httpStatus: 404, stream, attemptCount: 0 });
    return c.json({ error: { message: `no account serves model ${input.model}`, type: 'not_found' } }, 404);
  }
  if (!outcome.ok || !outcome.result) {
    const status = outcome.lastError?.httpStatus ?? 502;
    await logRequest(c.env.DB, { gatewayKeyId, publicModel: input.model, accountId: outcome.account?.id, status: 'error', httpStatus: status, latencyMs: Date.now() - started, stream, attemptCount: outcome.attempts });
    return c.json({ error: { message: `upstream error (${status >= 500 ? 'bad_gateway' : outcome.lastError?.reason ?? 'server'})`, type: status >= 500 ? 'bad_gateway' : outcome.lastError?.reason ?? 'server' } }, status as never);
  }
  const result = outcome.result, account = outcome.account!;
  if (stream && result.stream) {
    await logRequest(c.env.DB, { gatewayKeyId, publicModel: input.model, accountId: account.id, status: 'ok', httpStatus: 200, latencyMs: Date.now() - started, stream: true, attemptCount: outcome.attempts });
    return new Response(result.stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
  }
  if (stream) return c.json({ error: { message: 'upstream returned no stream body', type: 'bad_gateway' } }, 502);
  const parsed = getAdapter(account.adapter).parseResponse(result.status, result.json) as { usage?: Record<string, number> };
  const usage = parsed?.usage ?? {};
  await logRequest(c.env.DB, { gatewayKeyId, publicModel: input.model, accountId: account.id, status: 'ok', httpStatus: result.status,
    latencyMs: Date.now() - started, promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens, estCost: estimateCost(input.model, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0), attemptCount: outcome.attempts });
  return c.json(parsed, result.status as never);
});

app.post('/v1/messages', async (c) => {
  const started = Date.now(), gatewayKeyId = c.get('gatewayKeyId') ?? null;
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json(anthropicError('invalid_request_error', 'invalid JSON body'), 400); }
  if (typeof body.model !== 'string') return c.json(anthropicError('invalid_request_error', 'model required'), 400);
  const stream = body.stream === true, req = { ...body, model: body.model, stream } as ChatRequest;
  const outcome = await routeAndCall(c.env.DB, req, c.env.MASTER_KEY, { sessionId: c.req.header('x-session-id') ?? deriveStickyKey(req), adapter: 'anthropic' });
  if (outcome.noCandidates) {
    await logRequest(c.env.DB, { gatewayKeyId, publicModel: body.model, status: 'error', httpStatus: 404, stream, attemptCount: 0 });
    return c.json(anthropicError('not_found_error', `no account serves model ${body.model}`), 404);
  }
  if (!outcome.ok || !outcome.result) {
    const status = outcome.lastError?.httpStatus ?? 502;
    await logRequest(c.env.DB, { gatewayKeyId, publicModel: body.model, accountId: outcome.account?.id, status: 'error', httpStatus: status, latencyMs: Date.now() - started, stream, attemptCount: outcome.attempts });
    return c.json(anthropicError('api_error', 'upstream error'), status as never);
  }
  const result = outcome.result, account = outcome.account!;
  if (stream && result.stream) {
    await logRequest(c.env.DB, { gatewayKeyId, publicModel: body.model, accountId: account.id, status: 'ok', httpStatus: 200, latencyMs: Date.now() - started, stream: true, attemptCount: outcome.attempts });
    return new Response(result.stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
  }
  if (stream) return c.json(anthropicError('api_error', 'upstream returned no stream body'), 502);
  const parsed = getAdapter(account.adapter).parseResponse(result.status, result.json) as { usage?: Record<string, number> };
  const usage = parsed?.usage ?? {}, inputTokens = usage.input_tokens ?? null, outputTokens = usage.output_tokens ?? null;
  await logRequest(c.env.DB, { gatewayKeyId, publicModel: body.model, accountId: account.id, status: 'ok', httpStatus: result.status,
    latencyMs: Date.now() - started, promptTokens: inputTokens, completionTokens: outputTokens,
    totalTokens: inputTokens != null || outputTokens != null ? (inputTokens ?? 0) + (outputTokens ?? 0) : null, estCost: 0, attemptCount: outcome.attempts });
  return c.json(parsed, result.status as never);
});

app.get('/admin', (c) => c.html(consoleHtml as unknown as string));
app.use('/admin/*', async (c, next) => {
  if (c.req.path === '/admin/login') return next();
  if (!c.env.ADMIN_KEY || !(await verifySession(c.env.ADMIN_KEY, getCookie(c, COOKIE)))) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

app.post('/admin/login', async (c) => {
  if (!c.env.ADMIN_KEY) return c.json({ error: 'admin disabled' }, 404);
  const body = await c.req.json<{ key?: string }>().catch(() => ({})) as { key?: string };
  if (!body.key || !constantTimeEqual(await sha256(body.key), await sha256(c.env.ADMIN_KEY))) return c.json({ error: 'invalid admin key' }, 401);
  setCookie(c, COOKIE, await signSession(c.env.ADMIN_KEY), { httpOnly: true, sameSite: 'Strict', secure: true, path: '/admin', maxAge: SESSION_TTL_MS / 1000 });
  return c.json({ authed: true });
});
app.post('/admin/logout', (c) => { deleteCookie(c, COOKIE, { path: '/admin' }); return c.json({ authed: false }); });
app.get('/admin/session', (c) => c.json({ authed: true }));

app.get('/admin/accounts', async (c) => {
  const result = await c.env.DB.prepare(`SELECT a.id,a.name,a.provider,a.adapter,a.base_url,a.models,a.weight,a.egress,a.enabled,
    s.status,s.cooldown_until,s.consecutive_errors,s.last_used_at,s.last_error FROM accounts a
    LEFT JOIN account_state s ON s.account_id=a.id ORDER BY a.created_at`).all<AccountRow & Record<string, any>>();
  return c.json((result.results ?? []).map((row) => ({ ...accountFromRow(row), enabled: row.enabled === 1,
    state: { status: row.status ?? 'unknown', cooldownUntil: row.cooldown_until, consecutiveErrors: row.consecutive_errors ?? 0, lastUsedAt: row.last_used_at, lastError: row.last_error } })));
});

app.post('/admin/accounts', async (c) => {
  const body = await c.req.json<Record<string, any>>().catch(() => ({})) as Record<string, any>;
  if (!body.name || !body.adapter || !body.baseUrl || typeof body.key !== 'string') return c.json({ error: 'name, adapter, baseUrl, key required' }, 400);
  try { getAdapter(body.adapter); } catch { return c.json({ error: `unknown adapter: ${body.adapter}` }, 400); }
  const id = crypto.randomUUID(), now = Date.now(), secret = await encryptSecret(body.key, c.env.MASTER_KEY);
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO accounts (id,name,provider,adapter,base_url,models,weight,enabled,egress,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?,?)`)
      .bind(id, body.name, body.provider ?? 'custom', body.adapter, body.baseUrl, JSON.stringify(body.models ?? []), body.weight ?? 1, body.egress ?? null, now, now),
    c.env.DB.prepare('INSERT INTO credentials (id,account_id,type,secret_enc,meta) VALUES (?,?,?,?,NULL)').bind(crypto.randomUUID(), id, 'static_key', secret),
    c.env.DB.prepare("INSERT INTO account_state (account_id,status,consecutive_errors) VALUES (?,'unknown',0)").bind(id),
  ]);
  return c.json({ id }, 201);
});

app.patch('/admin/accounts/:id', async (c) => {
  const id = c.req.param('id'), body = await c.req.json<Record<string, any>>().catch(() => ({})) as Record<string, any>;
  const sets: string[] = [], values: Bind[] = [];
  for (const [field, column, transform] of [
    ['baseUrl', 'base_url', (v: unknown) => v], ['models', 'models', (v: unknown) => JSON.stringify(v)],
    ['weight', 'weight', (v: unknown) => v], ['enabled', 'enabled', (v: unknown) => v ? 1 : 0], ['egress', 'egress', (v: unknown) => v],
  ] as const) if (body[field] !== undefined) { sets.push(`${column}=?`); values.push(transform(body[field]) as Bind); }
  sets.push('updated_at=?'); values.push(Date.now(), id);
  await c.env.DB.prepare(`UPDATE accounts SET ${sets.join(',')} WHERE id=?`).bind(...values).run();
  if (typeof body.key === 'string') await c.env.DB.prepare('UPDATE credentials SET secret_enc=? WHERE account_id=?').bind(await encryptSecret(body.key, c.env.MASTER_KEY), id).run();
  return c.json({ ok: true });
});

app.delete('/admin/accounts/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.batch(['credentials', 'account_state', 'accounts'].map((table) => c.env.DB.prepare(`DELETE FROM ${table} WHERE ${table === 'accounts' ? 'id' : 'account_id'}=?`).bind(id)));
  return c.json({ ok: true });
});
app.post('/admin/accounts/:id/reset-cooldown', async (c) => {
  await c.env.DB.prepare("UPDATE account_state SET status='unknown',cooldown_until=NULL,consecutive_errors=0 WHERE account_id=?").bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

app.get('/admin/gateway-keys', async (c) => {
  const result = await c.env.DB.prepare('SELECT id,name,key_hash,enabled,created_at FROM gateway_keys ORDER BY created_at').all<Record<string, any>>();
  return c.json((result.results ?? []).map((row) => ({ id: row.id, name: row.name, keyHashPrefix: row.key_hash.slice(0, 8), enabled: row.enabled === 1, createdAt: row.created_at })));
});
app.post('/admin/gateway-keys', async (c) => {
  const body = await c.req.json<{ name?: string }>().catch(() => ({})) as { name?: string }, raw = `mk-${hex(crypto.getRandomValues(new Uint8Array(24)))}`, id = crypto.randomUUID();
  await c.env.DB.prepare('INSERT INTO gateway_keys (id,key_hash,name,enabled,created_at) VALUES (?,?,?,?,?)').bind(id, await sha256(raw), body.name ?? 'key', 1, Date.now()).run();
  return c.json({ id, key: raw }, 201);
});
app.delete('/admin/gateway-keys/:id', async (c) => { await c.env.DB.prepare('DELETE FROM gateway_keys WHERE id=?').bind(c.req.param('id')).run(); return c.json({ ok: true }); });

app.get('/admin/logs', async (c) => {
  const q = c.req.query(), where: string[] = [], args: Bind[] = [];
  for (const [key, col] of [['model', 'public_model'], ['account', 'account_id'], ['status', 'status']] as const) if (q[key]) { where.push(`${col}=?`); args.push(q[key]); }
  if (Number.isFinite(Number(q.sinceMs))) { where.push('ts>=?'); args.push(Number(q.sinceMs)); }
  if (Number.isFinite(Number(q.untilMs))) { where.push('ts<=?'); args.push(Number(q.untilMs)); }
  if (q.q) { where.push('(public_model LIKE ? OR account_id LIKE ? OR status LIKE ?)'); args.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '', limit = Math.min(Math.max(Number(q.limit) || 100, 1), 1000), offset = Math.max(Number(q.offset) || 0, 0);
  const [total, rows] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM request_logs ${clause}`).bind(...args).first<{ n: number }>(),
    c.env.DB.prepare(`SELECT * FROM request_logs ${clause} ORDER BY ts DESC LIMIT ${limit} OFFSET ${offset}`).bind(...args).all(),
  ]);
  return c.json({ rows: rows.results ?? [], total: total?.n ?? 0 });
});

app.get('/admin/stats', async (c) => {
  const since = Number.isFinite(Number(c.req.query('sinceMs'))) ? Number(c.req.query('sinceMs')) : 0;
  const totalsSql = `SELECT COUNT(*) total,COALESCE(SUM(CASE WHEN status='error' THEN 1 ELSE 0 END),0) errors,COALESCE(SUM(total_tokens),0) tokens,COALESCE(SUM(est_cost),0) cost FROM request_logs WHERE ts>=?`;
  const group = (column: string) => c.env.DB.prepare(`SELECT COALESCE(${column},'(none)') key,COUNT(*) requests,SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errors,COALESCE(SUM(total_tokens),0) tokens,COALESCE(SUM(est_cost),0) cost FROM request_logs WHERE ts>=? GROUP BY ${column} ORDER BY requests DESC`).bind(since).all();
  const span = since > 0 ? Date.now() - since : Number.MAX_SAFE_INTEGER, bucket = span <= 7200000 ? 300000 : span <= 172800000 ? 3600000 : 86400000;
  const [totals, byModel, byAccount, byKey, rawSeries] = await Promise.all([
    c.env.DB.prepare(totalsSql).bind(since).first<Record<string, number>>(), group('public_model'), group('account_id'), group('gateway_key_id'),
    c.env.DB.prepare(`SELECT CAST(ts/? AS INTEGER) bucketIdx,COUNT(*) requests,SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errors FROM request_logs WHERE ts>=? GROUP BY bucketIdx ORDER BY bucketIdx`).bind(bucket, since).all<Record<string, number>>(),
  ]);
  const total = totals?.total ?? 0;
  return c.json({ totalRequests: total, errorCount: totals?.errors ?? 0, errorRate: total ? (totals?.errors ?? 0) / total : 0,
    totalTokens: totals?.tokens ?? 0, totalCost: totals?.cost ?? 0, byModel: byModel.results ?? [], byAccount: byAccount.results ?? [], byKey: byKey.results ?? [],
    series: (rawSeries.results ?? []).map((row) => ({ bucket: row.bucketIdx * bucket, requests: row.requests, errors: row.errors })) });
});
app.get('/admin/models', async (c) => c.json(await publicModels(c.env.DB)));

app.post('/admin/detect-models', async (c) => {
  const body = await c.req.json<Record<string, any>>().catch(() => ({})) as Record<string, any>;
  if (!body.baseUrl || typeof body.key !== 'string' || !body.key) return c.json({ ok: false, error: 'baseUrl 与 key 必填(检测需要凭证)' }, 400);
  const anthropic = body.adapter === 'anthropic';
  try {
    const response = await fetch(joinPath(String(body.baseUrl), '/models'), { headers: anthropic
      ? { 'x-api-key': body.key, authorization: `Bearer ${body.key}`, 'anthropic-version': '2023-06-01' }
      : { authorization: `Bearer ${body.key}` } });
    if (!response.ok) return c.json({ ok: false, error: `上游返回 ${response.status};该渠道可能未提供模型列表,请手动填写` });
    const json = await response.json().catch(() => null) as Record<string, any> | null, list = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : null;
    if (!list) return c.json({ ok: false, error: '未能解析模型列表(响应格式不符),请手动填写' });
    return c.json({ ok: true, models: [...new Set(list.map((item: any) => typeof item === 'string' ? item : item?.id).filter(Boolean))] });
  } catch (error) { return c.json({ ok: false, error: `请求失败:${error instanceof Error ? error.message : 'network error'}` }); }
});

app.post('/admin/test', async (c) => {
  const body = await c.req.json<Record<string, any>>().catch(() => ({})) as Record<string, any>;
  if (!body.model || typeof body.message !== 'string') return c.json({ error: 'model and message required' }, 400);
  const req: ChatRequest = { model: body.model, messages: [{ role: 'user', content: body.message }], stream: false, ...(body.protocol === 'anthropic' ? { max_tokens: 1024 } : {}) };
  const started = Date.now(), outcome = await routeAndCall(c.env.DB, req, c.env.MASTER_KEY, { sessionId: body.sessionId, adapter: body.protocol === 'anthropic' ? 'anthropic' : 'openai' });
  const latencyMs = Date.now() - started;
  if (outcome.noCandidates) return c.json({ ok: false, status: 'no_candidates', latencyMs, attempts: 0 }, 404);
  if (!outcome.ok || !outcome.result) return c.json({ ok: false, status: 'error', accountId: outcome.account?.id ?? null, httpStatus: outcome.lastError?.httpStatus ?? 502, attempts: outcome.attempts, latencyMs, error: 'upstream error' });
  const parsed = getAdapter(outcome.account!.adapter).parseResponse(outcome.result.status, outcome.result.json) as Record<string, any>;
  return c.json({ ok: true, status: 'ok', accountId: outcome.account!.id, httpStatus: outcome.result.status, latencyMs, attempts: outcome.attempts, usage: parsed?.usage ?? {}, sample: JSON.stringify(parsed).slice(0, 500) });
});

export default app;
