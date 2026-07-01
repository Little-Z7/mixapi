import { test, expect } from 'bun:test';
import { callUpstream } from '../src/core/upstream';
import type { UpstreamRequest } from '../src/adapters/types';

const u: UpstreamRequest = { url: 'https://x.test/chat/completions', headers: {}, body: '{}' };

test('non-stream returns parsed json', async () => {
  const fetchFn = (async () =>
    new Response(JSON.stringify({ ok: 1 }), { status: 200 })) as unknown as typeof fetch;
  const r = await callUpstream(u, false, fetchFn);
  expect(r.status).toBe(200);
  expect(r.json).toEqual({ ok: 1 });
  expect(r.stream).toBeUndefined();
});

test('stream ok returns stream', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) { ctrl.enqueue(new TextEncoder().encode('data: hi\n\n')); ctrl.close(); },
  });
  const fetchFn = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
  const r = await callUpstream(u, true, fetchFn);
  expect(r.status).toBe(200);
  expect(r.stream).toBeDefined();
});

test('stream but error status returns json for classification', async () => {
  const fetchFn = (async () =>
    new Response(JSON.stringify({ error: 'rl' }), { status: 429 })) as unknown as typeof fetch;
  const r = await callUpstream(u, true, fetchFn);
  expect(r.status).toBe(429);
  expect(r.stream).toBeUndefined();
  expect(r.json).toEqual({ error: 'rl' });
});
