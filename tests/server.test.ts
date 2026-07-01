import { test, expect } from 'bun:test';
import { buildApp } from '../src/server';

test('GET /healthz returns ok', async () => {
  const app = buildApp();
  const res = await app.request('/healthz');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: 'ok' });
});
