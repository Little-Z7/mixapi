import { Hono } from 'hono';
import { routeAndCall } from '../core/failover';
import { deriveStickyKey } from '../core/sticky';
import { logRequest, estimateCost } from '../usage';
import type { RouteDeps } from './openai-routes';
import {
  responsesToChat, chatChoiceToOutput, buildResponse, chatSseToResponses,
  type ResponseCtx, type ResponsesRequest,
} from './responses-translate';

function respError(message: string, type: string) {
  return { error: { message, type, param: null, code: null } };
}

const shortId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 24);

function sumTokens(inTok: number | null, outTok: number | null, total: unknown): number | null {
  if (typeof total === 'number') return total;
  return inTok != null || outTok != null ? (inTok ?? 0) + (outTok ?? 0) : null;
}

export function registerResponsesRoutes(app: Hono, deps: RouteDeps): void {
  const { db, masterKeyHex } = deps;
  const fetchFn = deps.fetchFn ?? fetch;

  app.post('/v1/responses', async (c) => {
    const started = Date.now();
    const gatewayKeyId = c.get('gatewayKeyId') ?? null;
    let body: ResponsesRequest;
    try { body = (await c.req.json()) as ResponsesRequest; }
    catch { return c.json(respError('invalid JSON body', 'invalid_request_error'), 400); }
    if (!body?.model) return c.json(respError('model required', 'invalid_request_error'), 400);

    const stream = body.stream === true;
    const chatReq = responsesToChat(body);
    // x-session-id wins; else derive a sticky key so a conversation keeps hitting one account.
    const sessionId = c.req.header('x-session-id') ?? deriveStickyKey(chatReq);

    const outcome = await routeAndCall(db, chatReq, masterKeyHex, { fetchFn, sessionId, adapter: 'openai' });

    if (outcome.noCandidates) {
      logRequest(db, { gatewayKeyId, publicModel: body.model, status: 'error', httpStatus: 404, stream, attemptCount: 0 });
      return c.json(respError(`no account serves model ${body.model}`, 'not_found_error'), 404);
    }
    if (!outcome.ok || !outcome.result) {
      const httpStatus = outcome.lastError?.httpStatus ?? 502;
      const type = httpStatus >= 500 ? 'api_error' : (outcome.lastError?.reason ?? 'api_error');
      logRequest(db, { gatewayKeyId, publicModel: body.model, accountId: outcome.account?.id ?? null, status: 'error', httpStatus, latencyMs: Date.now() - started, stream, attemptCount: outcome.attempts });
      return c.json(respError(`upstream error (${type})`, String(type)), httpStatus as any);
    }

    const result = outcome.result;
    const account = outcome.account!;
    const ctx: ResponseCtx = {
      id: 'resp_' + shortId(),
      createdAt: Math.floor(started / 1000),
      model: body.model,
      echo: {
        temperature: body.temperature ?? null,
        top_p: body.top_p ?? null,
        max_output_tokens: body.max_output_tokens ?? null,
        tools: Array.isArray(body.tools) ? body.tools : [],
        tool_choice: body.tool_choice ?? 'auto',
        instructions: typeof body.instructions === 'string' ? body.instructions : null,
        metadata: (body.metadata as Record<string, unknown>) ?? {},
      },
    };

    if (stream && result.stream) {
      const out = chatSseToResponses(result.stream, ctx, shortId, (usage) => {
        const inTok = usage?.prompt_tokens ?? null;
        const outTok = usage?.completion_tokens ?? null;
        logRequest(db, {
          gatewayKeyId, publicModel: body.model, accountId: account.id, status: 'ok', httpStatus: 200,
          latencyMs: Date.now() - started, promptTokens: inTok, completionTokens: outTok,
          totalTokens: sumTokens(inTok, outTok, usage?.total_tokens),
          estCost: estimateCost(body.model, inTok ?? 0, outTok ?? 0), attemptCount: outcome.attempts, stream: true,
        });
      });
      return new Response(out, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } });
    }
    if (stream && !result.stream) {
      logRequest(db, { gatewayKeyId, publicModel: body.model, accountId: account.id, status: 'error', httpStatus: 502, latencyMs: Date.now() - started, stream, attemptCount: outcome.attempts });
      return c.json(respError('upstream returned no stream body', 'api_error'), 502);
    }

    const chat = result.json as any;
    const output = chatChoiceToOutput(chat, shortId);
    const usage = chat?.usage ?? {};
    const finish = chat?.choices?.[0]?.finish_reason;
    const responseObj = buildResponse(ctx, { output, usage, finish });
    const inTok = usage.prompt_tokens ?? null;
    const outTok = usage.completion_tokens ?? null;
    logRequest(db, {
      gatewayKeyId, publicModel: body.model, accountId: account.id, status: 'ok', httpStatus: result.status,
      latencyMs: Date.now() - started, promptTokens: inTok, completionTokens: outTok,
      totalTokens: sumTokens(inTok, outTok, usage.total_tokens),
      estCost: estimateCost(body.model, inTok ?? 0, outTok ?? 0), attemptCount: outcome.attempts, stream: false,
    });
    return c.json(responseObj, result.status as any);
  });
}
