import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { hashKey } from './auth';
import { CONSOLE_HTML } from '../admin/console-page';
import { signSession, verifySession, SESSION_TTL_MS } from '../admin/session';
import { timingSafeEqual } from 'node:crypto';
import { insertAccount, listAccountsWithState, updateAccount, deleteAccount, setCredential, resetCooldown, listPublicModels } from '../data/accounts';
import { listGatewayKeys, createGatewayKey, deleteGatewayKey } from './auth';
import { listLogs, aggregateStats } from '../admin/queries';
import { encryptSecret } from '../credentials/crypto';
import { getAdapter } from '../adapters/registry';
import { routeAndCall } from '../core/failover';
import { joinPath } from '../adapters/types';

export interface AdminDeps { db: Database; masterKeyHex: string; adminKey: string; fetchFn?: typeof fetch; }

const COOKIE = 'mixadmin';

function keyMatches(input: string, adminKey: string): boolean {
  const a = Buffer.from(hashKey(input));
  const b = Buffer.from(hashKey(adminKey));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerAdminRoutes(app: Hono, deps: AdminDeps): void {
  const { adminKey } = deps;
  const secureCookie = process.env.ADMIN_INSECURE_COOKIE !== '1';

  // self-contained console page (public shell; data endpoints below require the session cookie)
  app.get('/admin', (c) => c.html(CONSOLE_HTML));

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

  const { db, masterKeyHex } = deps;
  const fetchFn = deps.fetchFn ?? fetch;

  app.get('/admin/accounts', (c) => c.json(listAccountsWithState(db)));

  app.post('/admin/accounts', async (c) => {
    const b = await c.req.json().catch(() => ({} as any));
    if (!b?.name || !b?.adapter || !b?.baseUrl || typeof b?.key !== 'string') {
      return c.json({ error: 'name, adapter, baseUrl, key required' }, 400);
    }
    try { getAdapter(b.adapter); } catch { return c.json({ error: `unknown adapter: ${b.adapter}` }, 400); }
    const id = insertAccount(db, {
      name: b.name, provider: b.provider ?? 'custom', adapter: b.adapter, baseUrl: b.baseUrl,
      models: b.models ?? [], weight: b.weight ?? 1, egress: b.egress ?? null,
      secretEnc: encryptSecret(b.key, masterKeyHex),
    });
    return c.json({ id }, 201);
  });

  app.patch('/admin/accounts/:id', async (c) => {
    const id = c.req.param('id');
    const b = await c.req.json().catch(() => ({} as any));
    updateAccount(db, id, { baseUrl: b.baseUrl, models: b.models, weight: b.weight, enabled: b.enabled, egress: b.egress });
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
    const num = (v?: string) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
    return c.json(listLogs(db, {
      limit: num(q.limit), offset: num(q.offset),
      model: q.model, account: q.account, status: q.status,
      sinceMs: num(q.sinceMs), untilMs: num(q.untilMs), q: q.q,
    }));
  });
  app.get('/admin/stats', (c) => {
    const raw = Number(c.req.query('sinceMs'));
    return c.json(aggregateStats(db, Number.isFinite(raw) ? raw : 0));
  });
  app.get('/admin/models', (c) => c.json(listPublicModels(db)));

  // Probe an upstream channel's model list — best-effort GET {baseUrl}/models with the
  // provided key. Admin-gated; returns only model names, never echoes the key or logs.
  app.post('/admin/detect-models', async (c) => {
    const b = await c.req.json().catch(() => ({} as any));
    if (!b?.baseUrl || typeof b?.key !== 'string' || !b.key) {
      return c.json({ ok: false, error: 'baseUrl 与 key 必填(检测需要凭证)' }, 400);
    }
    const adapter = b.adapter === 'anthropic' ? 'anthropic' : 'openai';
    const url = joinPath(String(b.baseUrl), '/models');
    const headers: Record<string, string> = adapter === 'anthropic'
      ? { 'x-api-key': b.key, authorization: `Bearer ${b.key}`, 'anthropic-version': '2023-06-01' }
      : { authorization: `Bearer ${b.key}` };
    try {
      const r = await fetchFn(url, { method: 'GET', headers });
      if (!r.ok) return c.json({ ok: false, error: `上游返回 ${r.status};该渠道可能未提供模型列表,请手动填写` });
      const j: any = await r.json().catch(() => null);
      const list = Array.isArray(j?.data) ? j.data : (Array.isArray(j?.models) ? j.models : null);
      if (!list) return c.json({ ok: false, error: '未能解析模型列表(响应格式不符),请手动填写' });
      const models = [...new Set(list.map((m: any) => (typeof m === 'string' ? m : m?.id)).filter((x: any) => typeof x === 'string' && x))];
      return c.json({ ok: true, models });
    } catch (e: any) {
      return c.json({ ok: false, error: `请求失败:${e?.message || 'network error'}` });
    }
  });

  // Playground: send one request through the pool and report routing + response.
  // Routes internally via routeAndCall (reuses pooling/failover) and does NOT log.
  app.post('/admin/test', async (c) => {
    const b = await c.req.json().catch(() => ({} as any));
    if (!b?.model || typeof b?.message !== 'string') return c.json({ error: 'model and message required' }, 400);
    const protocol = b.protocol === 'anthropic' ? 'anthropic' : 'openai';
    const req: any = { model: b.model, messages: [{ role: 'user', content: b.message }], stream: false };
    if (protocol === 'anthropic') req.max_tokens = 1024;
    const started = Date.now();
    const outcome = await routeAndCall(db, req, masterKeyHex, { fetchFn, sessionId: b.sessionId, adapter: protocol });
    const latencyMs = Date.now() - started;
    if (outcome.noCandidates) return c.json({ ok: false, status: 'no_candidates', latencyMs, attempts: 0 }, 404);
    if (!outcome.ok || !outcome.result) {
      return c.json({
        ok: false, status: 'error', accountId: outcome.account?.id ?? null,
        httpStatus: outcome.lastError?.httpStatus ?? 502, attempts: outcome.attempts, latencyMs, error: 'upstream error',
      });
    }
    const account = outcome.account!;
    const parsed = getAdapter(account.adapter).parseResponse(outcome.result.status, outcome.result.json) as any;
    return c.json({
      ok: true, status: 'ok', accountId: account.id, httpStatus: outcome.result.status,
      latencyMs, attempts: outcome.attempts, usage: parsed?.usage ?? {}, sample: JSON.stringify(parsed).slice(0, 500),
    });
  });
}
