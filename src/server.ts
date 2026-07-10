import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import { resolveGatewayKeyId } from './ingress/auth';
import { registerOpenAIRoutes } from './ingress/openai-routes';
import { registerResponsesRoutes } from './ingress/responses-routes';
import { registerAnthropicRoutes } from './ingress/anthropic-routes';
import { registerAdminRoutes } from './ingress/admin-routes';

declare module 'hono' {
  interface ContextVariableMap { gatewayKeyId?: string }
}

export interface AppDeps { db: Database; masterKeyHex: string; fetchFn?: typeof fetch; adminKey?: string; }

export function buildApp(deps?: AppDeps): Hono {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  if (deps) {
    app.use('/v1/*', async (c, next) => {
      const gatewayKeyId = resolveGatewayKeyId(deps.db, c.req.header('authorization'));
      if (!gatewayKeyId) {
        return c.json({ error: { message: 'invalid gateway key', type: 'auth' } }, 401);
      }
      c.set('gatewayKeyId', gatewayKeyId);
      await next();
    });
    registerOpenAIRoutes(app, deps);
    registerResponsesRoutes(app, deps);
    registerAnthropicRoutes(app, deps);
    if (deps.adminKey) registerAdminRoutes(app, { db: deps.db, masterKeyHex: deps.masterKeyHex, adminKey: deps.adminKey, fetchFn: deps.fetchFn });
  }
  return app;
}
