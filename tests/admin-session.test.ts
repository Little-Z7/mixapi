import { test, expect } from 'bun:test';
import { signSession, verifySession, SESSION_TTL_MS } from '../src/admin/session';

const KEY = 'admin-secret';

test('sign then verify round-trips', () => {
  const t = signSession(KEY, 1000);
  expect(verifySession(KEY, t, 2000)).toBe(true);
});

test('expired token is rejected', () => {
  const t = signSession(KEY, 1000);
  expect(verifySession(KEY, t, 1000 + SESSION_TTL_MS + 1)).toBe(false);
});

test('tampered mac is rejected', () => {
  const t = signSession(KEY, 1000);
  const bad = t.slice(0, -1) + (t.endsWith('a') ? 'b' : 'a');
  expect(verifySession(KEY, bad, 2000)).toBe(false);
});

test('wrong admin key is rejected', () => {
  const t = signSession(KEY, 1000);
  expect(verifySession('other-secret', t, 2000)).toBe(false);
});

test('missing / malformed token is rejected', () => {
  expect(verifySession(KEY, undefined, 2000)).toBe(false);
  expect(verifySession(KEY, 'no-dot-here', 2000)).toBe(false);
});
