import { test, expect } from 'bun:test';
import { openDb, applySchema } from '../src/data/db';
import { insertAccount } from '../src/data/accounts';
import { encryptSecret } from '../src/credentials/crypto';
import { seedGatewayKey } from '../src/ingress/auth';
import { countLogs } from '../src/usage/logger';
import { buildApp } from '../src/server';
import {
  responsesToChat, chatChoiceToOutput, buildResponse, toResponsesUsage,
  type ResponseCtx,
} from '../src/ingress/responses-translate';

const KEY = 'a'.repeat(64);

function setup() {
  const db = openDb(':memory:');
  applySchema(db);
  seedGatewayKey(db, 'gw');
  insertAccount(db, {
    name: 'glm', provider: 'glm', adapter: 'openai', baseUrl: 'https://up.test/v1',
    models: [{ public: 'glm-4.6', target: 'glm-real' }], weight: 1, egress: null,
    secretEnc: encryptSecret('sk-up', KEY),
  });
  return db;
}

const ctx = (): ResponseCtx => ({
  id: 'resp_test', createdAt: 1000, model: 'glm-4.6',
  echo: { temperature: null, top_p: null, max_output_tokens: null, tools: [], tool_choice: 'auto', instructions: null, metadata: {} },
});
let n = 0;
const ids = () => `id${n++}`;

// ---- pure translation ----

test('responsesToChat: string input -> user message', () => {
  const chat = responsesToChat({ model: 'm', input: 'hey' });
  expect(chat.messages).toEqual([{ role: 'user', content: 'hey' }]);
  expect(chat.stream).toBe(false);
});

test('responsesToChat: instructions -> leading system message, max_output_tokens -> max_tokens', () => {
  const chat = responsesToChat({ model: 'm', instructions: 'be terse', input: 'hi', max_output_tokens: 50, temperature: 0.5 });
  expect(chat.messages[0]).toEqual({ role: 'system', content: 'be terse' });
  expect(chat.messages[1]).toEqual({ role: 'user', content: 'hi' });
  expect((chat as any).max_tokens).toBe(50);
  expect((chat as any).temperature).toBe(0.5);
});

test('responsesToChat: array input with content parts collapses to text', () => {
  const chat = responsesToChat({ model: 'm', input: [
    { role: 'user', content: [{ type: 'input_text', text: 'a' }, { type: 'input_text', text: 'b' }, { type: 'input_image', image_url: 'x' }] },
  ] });
  expect(chat.messages).toEqual([{ role: 'user', content: 'ab' }]);
});

test('responsesToChat: function tools reshaped, stream injects include_usage', () => {
  const chat = responsesToChat({
    model: 'm', input: 'hi', stream: true,
    tools: [{ type: 'function', name: 'get_weather', description: 'd', parameters: { type: 'object' } }],
  });
  expect((chat as any).tools).toEqual([{ type: 'function', function: { name: 'get_weather', description: 'd', parameters: { type: 'object' } } }]);
  expect((chat as any).stream_options).toEqual({ include_usage: true });
});

test('chatChoiceToOutput + buildResponse: text message and usage translation', () => {
  const output = chatChoiceToOutput({ choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }] }, ids);
  const resp = buildResponse(ctx(), { output, usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }, finish: 'stop' });
  expect(resp.object).toBe('response');
  expect(resp.status).toBe('completed');
  expect(resp.output[0].content[0]).toEqual({ type: 'output_text', text: 'hello', annotations: [] });
  expect(resp.output_text).toBe('hello');
  expect(resp.usage).toEqual({ input_tokens: 3, output_tokens: 2, total_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } });
});

test('chatChoiceToOutput: tool_calls -> function_call items', () => {
  const output = chatChoiceToOutput({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"x":1}' } }] }, finish_reason: 'tool_calls' }] }, ids);
  expect(output[0]).toMatchObject({ type: 'function_call', call_id: 'call_1', name: 'f', arguments: '{"x":1}', status: 'completed' });
});

test('buildResponse: length finish -> incomplete', () => {
  const resp = buildResponse(ctx(), { output: [], usage: null, finish: 'length' });
  expect(resp.status).toBe('incomplete');
  expect(resp.incomplete_details).toEqual({ reason: 'max_output_tokens' });
});

test('toResponsesUsage: null in null out', () => {
  expect(toResponsesUsage(null)).toBeNull();
});

// ---- integration ----

test('401 without valid gateway key', async () => {
  const db = setup();
  const app = buildApp({ db, masterKeyHex: KEY, fetchFn: (async () => new Response('{}')) as unknown as typeof fetch });
  const res = await app.request('/v1/responses', { method: 'POST', body: '{}' });
  expect(res.status).toBe(401);
});

test('non-stream: translates to chat upstream, returns Responses shape, logs usage', async () => {
  const db = setup();
  const upstreamJson = { id: 'x', model: 'glm-real', choices: [{ message: { role: 'assistant', content: 'hi there' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } };
  let seenBody: any = null;
  let seenUrl = '';
  const fetchFn = (async (url: string, init: RequestInit) => {
    seenUrl = url; seenBody = JSON.parse(init.body as string);
    return new Response(JSON.stringify(upstreamJson), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const app = buildApp({ db, masterKeyHex: KEY, fetchFn });
  const res = await app.request('/v1/responses', {
    method: 'POST',
    headers: { authorization: 'Bearer gw', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-4.6', input: 'hey', instructions: 'sys' }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.object).toBe('response');
  expect(body.output_text).toBe('hi there');
  expect(body.usage.input_tokens).toBe(4);
  // upstream saw chat/completions with translated messages + renamed model
  expect(seenUrl).toBe('https://up.test/v1/chat/completions');
  expect(seenBody.model).toBe('glm-real');
  expect(seenBody.messages).toEqual([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hey' }]);
  const log = db.query('SELECT prompt_tokens,completion_tokens,total_tokens FROM request_logs ORDER BY ts DESC LIMIT 1').get() as any;
  expect(log).toMatchObject({ prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 });
});

test('stream: chat SSE is translated to Responses events and usage is logged', async () => {
  const db = setup();
  const sse =
    'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
    'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n\n' +
    'data: [DONE]\n\n';
  let seenBody: any = null;
  const fetchFn = (async (_url: string, init: RequestInit) => {
    seenBody = JSON.parse(init.body as string);
    return new Response(
      new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    );
  }) as unknown as typeof fetch;
  const app = buildApp({ db, masterKeyHex: KEY, fetchFn });
  const res = await app.request('/v1/responses', {
    method: 'POST',
    headers: { authorization: 'Bearer gw', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-4.6', input: 'hi', stream: true }),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  // translation asked upstream to include usage
  expect(seenBody.stream_options).toEqual({ include_usage: true });
  const text = await res.text();
  expect(text).toContain('event: response.created');
  expect(text).toContain('event: response.output_text.delta');
  expect(text).toContain('"delta":"Hel"');
  expect(text).toContain('event: response.completed');
  expect(text).toContain('"output_text":"Hello"');
  // usage from the trailing chunk made it into the completed event and the log
  expect(text).toContain('"input_tokens":5');
  const log = db.query('SELECT prompt_tokens,completion_tokens,stream FROM request_logs ORDER BY ts DESC LIMIT 1').get() as any;
  expect(log).toMatchObject({ prompt_tokens: 5, completion_tokens: 1, stream: 1 });
});

test('no account for model -> 404', async () => {
  const db = setup();
  const app = buildApp({ db, masterKeyHex: KEY, fetchFn: (async () => new Response('{}')) as unknown as typeof fetch });
  const res = await app.request('/v1/responses', {
    method: 'POST',
    headers: { authorization: 'Bearer gw', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'nope', input: 'x' }),
  });
  expect(res.status).toBe(404);
  expect((await res.json()).error.type).toBe('not_found_error');
});

test('malformed JSON -> 400', async () => {
  const db = setup();
  const app = buildApp({ db, masterKeyHex: KEY, fetchFn: (async () => new Response('{}')) as unknown as typeof fetch });
  const res = await app.request('/v1/responses', {
    method: 'POST',
    headers: { authorization: 'Bearer gw', 'content-type': 'application/json' },
    body: 'not json{',
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error.type).toBe('invalid_request_error');
});

test('upstream 429 is retried across the pool (attempt_count=2)', async () => {
  const db = openDb(':memory:'); applySchema(db); seedGatewayKey(db, 'gw');
  for (const name of ['a', 'b']) {
    insertAccount(db, {
      name, provider: 'glm', adapter: 'openai', baseUrl: 'https://up.test/v1',
      models: [{ public: 'glm-4.6', target: 'glm-real' }], weight: 1, egress: null,
      secretEnc: encryptSecret('sk-up', KEY),
    });
  }
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    return calls === 1
      ? new Response(JSON.stringify({ error: 'rl' }), { status: 429 })
      : new Response(JSON.stringify({ id: 'x', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const app = buildApp({ db, masterKeyHex: KEY, fetchFn });
  const res = await app.request('/v1/responses', {
    method: 'POST',
    headers: { authorization: 'Bearer gw', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-4.6', input: 'hi' }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).output_text).toBe('ok');
  const log = db.query('SELECT attempt_count FROM request_logs ORDER BY ts DESC LIMIT 1').get() as any;
  expect(log.attempt_count).toBe(2);
});
