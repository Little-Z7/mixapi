import { test, expect } from 'bun:test';
import { openaiAdapter, getAdapter } from '../src/adapters/openai';
import type { ChatRequest } from '../src/adapters/types';
import type { ResolvedAccount } from '../src/data/accounts';

const account: ResolvedAccount = {
  id: 'a1', name: 'glm', provider: 'glm', adapter: 'openai',
  baseUrl: 'https://api.test/v1/', models: [{ public: 'glm-4.6', target: 'glm-real' }],
  weight: 1, egress: null,
};
const req: ChatRequest = { model: 'glm-4.6', messages: [{ role: 'user', content: 'hi' }], stream: false };

test('buildRequest maps model, sets auth + url', () => {
  const u = openaiAdapter.buildRequest(req, account, 'sk-key');
  expect(u.url).toBe('https://api.test/v1/chat/completions');
  expect(u.headers.authorization).toBe('Bearer sk-key');
  const body = JSON.parse(u.body);
  expect(body.model).toBe('glm-real');
  expect(body.messages[0].content).toBe('hi');
});

test('classifyError maps statuses', () => {
  const h = new Headers({ 'retry-after': '12' });
  expect(openaiAdapter.classifyError(429, {}, h)).toEqual({ retryable: true, reason: 'rate_limit', cooldownMs: 12000 });
  expect(openaiAdapter.classifyError(401, {}, new Headers()).reason).toBe('auth');
  expect(openaiAdapter.classifyError(400, {}, new Headers())).toEqual({ retryable: false, reason: 'bad_request' });
  expect(openaiAdapter.classifyError(503, {}, new Headers()).reason).toBe('server');
});

test('translateStreamChunk passes through', () => {
  expect(openaiAdapter.translateStreamChunk('{"x":1}')).toEqual(['{"x":1}']);
});

test('getAdapter throws on unknown', () => {
  expect(getAdapter('openai').name).toBe('openai');
  expect(() => getAdapter('nope')).toThrow();
});
