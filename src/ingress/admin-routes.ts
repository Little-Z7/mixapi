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

export interface AdminDeps { db: Database; masterKeyHex: string; adminKey: string; }

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
}
