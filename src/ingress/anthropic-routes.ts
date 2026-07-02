import { Hono } from 'hono';
import { routeAndCall } from '../core/failover';
import { getAdapter } from '../adapters/registry';
import { logRequest } from '../usage';
import type { ChatRequest } from '../adapters/types';
import type { RouteDeps } from './openai-routes';

function anthropicError(type: string, message: string) {
  return { type: 'error', error: { type, message } };
}

export function registerAnthropicRoutes(app: Hono, deps: RouteDeps): void {
  const { db, masterKeyHex } = deps;
  const fetchFn = deps.fetchFn ?? fetch;

  app.post('/v1/messages', async (c) => {
    const started = Date.now();
    let body: any;
    try { body = await c.req.json(); }
    catch { return c.json(anthropicError('invalid_request_error', 'invalid JSON body'), 400); }
    if (!body?.model) return c.json(anthropicError('invalid_request_error', 'model required'), 400);
    const stream = body.stream === true;
    const req = { ...body, model: body.model, stream } as ChatRequest;
    const sessionId = c.req.header('x-session-id');

    const outcome = await routeAndCall(db, req, masterKeyHex, { fetchFn, sessionId, adapter: 'anthropic' });

    if (outcome.noCandidates) {
      logRequest(db, { publicModel: body.model, status: 'error', httpStatus: 404, stream, attemptCount: 0 });
      return c.json(anthropicError('not_found_error', `no account serves model ${body.model}`), 404);
    }
    if (!outcome.ok || !outcome.result) {
      const httpStatus = outcome.lastError?.httpStatus ?? 502;
      logRequest(db, { publicModel: body.model, accountId: outcome.account?.id ?? null, status: 'error', httpStatus, latencyMs: Date.now() - started, stream, attemptCount: outcome.attempts });
      return c.json(anthropicError('api_error', 'upstream error'), httpStatus as any);
    }

    const result = outcome.result;
    const account = outcome.account!;

    if (stream && result.stream) {
      logRequest(db, { publicModel: body.model, accountId: account.id, status: 'ok', httpStatus: 200, latencyMs: Date.now() - started, stream: true, attemptCount: outcome.attempts });
      return new Response(result.stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } });
    }
    if (stream && !result.stream) {
      logRequest(db, { publicModel: body.model, accountId: account.id, status: 'error', httpStatus: 502, latencyMs: Date.now() - started, stream, attemptCount: outcome.attempts });
      return c.json(anthropicError('api_error', 'upstream returned no stream body'), 502);
    }

    const parsed = getAdapter(account.adapter).parseResponse(result.status, result.json) as any;
    const usage = parsed?.usage ?? {};
    const inTok = usage.input_tokens ?? null, outTok = usage.output_tokens ?? null;
    logRequest(db, {
      publicModel: body.model, accountId: account.id, status: 'ok', httpStatus: result.status,
      latencyMs: Date.now() - started, promptTokens: inTok, completionTokens: outTok,
      totalTokens: inTok != null || outTok != null ? (inTok ?? 0) + (outTok ?? 0) : null,
      estCost: 0, attemptCount: outcome.attempts, stream: false,
    });
    return c.json(parsed, result.status as any);
  });
}
