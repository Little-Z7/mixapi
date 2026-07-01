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
