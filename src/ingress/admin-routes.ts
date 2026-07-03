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
