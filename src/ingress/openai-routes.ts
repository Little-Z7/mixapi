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
