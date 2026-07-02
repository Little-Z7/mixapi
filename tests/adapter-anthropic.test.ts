import { test, expect } from 'bun:test';
import { anthropicAdapter } from '../src/adapters/anthropic';
import { getAdapter } from '../src/adapters/registry';
import type { ChatRequest } from '../src/adapters/types';
import type { ResolvedAccount } from '../src/data/accounts';

const account: ResolvedAccount = {
  id: 'a1', name: 'glm', provider: 'glm', adapter: 'anthropic',
  baseUrl: 'https://api.z.ai/api/anthropic', models: [{ public: 'glm-5.2', target: 'glm-real' }],
  weight: 1, egress: null,
};
const req = { model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }], stream: false } as unknown as ChatRequest;

test('buildRequest hits /v1/messages with both auth headers and renamed model', () => {
  const u = anthropicAdapter.buildRequest(req, account, 'sk-tok');
  expect(u.url).toBe('https://api.z.ai/api/anthropic/v1/messages');
  expect(u.headers['x-api-key']).toBe('sk-tok');
  expect(u.headers.authorization).toBe('Bearer sk-tok');
  expect(u.headers['anthropic-version']).toBeTruthy();
  expect(JSON.parse(u.body).model).toBe('glm-real');
});

test('classifyError maps Anthropic statuses', () => {
  expect(anthropicAdapter.classifyError(429, {}, new Headers({ 'retry-after': '7' }))).toEqual({ retryable: true, reason: 'rate_limit', cooldownMs: 7000 });
  expect(anthropicAdapter.classifyError(429, {}, new Headers({ 'retry-after': 'Wed, 21 Oct 2099 07:28:00 GMT' })).cooldownMs).toBe(30000); // NaN guard → default
  expect(anthropicAdapter.classifyError(401, {}, new Headers()).reason).toBe('auth');
  expect(anthropicAdapter.classifyError(400, {}, new Headers())).toEqual({ retryable: false, reason: 'bad_request' });
  expect(anthropicAdapter.classifyError(529, {}, new Headers()).reason).toBe('server');
});

test('parseResponse and translateStreamChunk pass through', () => {
  expect(anthropicAdapter.parseResponse(200, { content: [{ text: 'hi' }] })).toEqual({ content: [{ text: 'hi' }] });
  expect(anthropicAdapter.translateStreamChunk('{"x":1}')).toEqual(['{"x":1}']);
});

test('registry resolves both adapters, throws on unknown', () => {
  expect(getAdapter('anthropic').name).toBe('anthropic');
  expect(getAdapter('openai').name).toBe('openai');
  expect(() => getAdapter('nope')).toThrow();
});
