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

    const outcome = await routeAndCall(db, chatReq, masterKeyHex, { fetchFn, sessionId, adapter: 'openai' });

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
