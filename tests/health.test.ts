import { test, expect } from 'bun:test';
import { openDb, applySchema } from '../src/data/db';
import { insertAccount } from '../src/data/accounts';
import { applyError, applySuccess, backoff, BACKOFF_CAP_MS, QUOTA_COOLDOWN_MS } from '../src/core/health';

function seed() {
  const db = openDb(':memory:');
  applySchema(db);
  const id = insertAccount(db, {
    name: 'a', provider: 'glm', adapter: 'openai', baseUrl: 'https://x.test/v1',
    models: [{ public: 'm', target: 'm' }], weight: 1, egress: null, secretEnc: new Uint8Array([1]),
  });
  return { db, id };
}
function state(db: any, id: string) {
  return db.query('SELECT status,cooldown_until,consecutive_errors,last_error FROM account_state WHERE account_id=?').get(id);
}

test('rate_limit with cooldownMs -> cooling at now+cooldownMs', () => {
  const { db, id } = seed();
  applyError(db, id, { retryable: true, reason: 'rate_limit', cooldownMs: 12000 }, 1000);
  expect(state(db, id)).toMatchObject({ status: 'cooling', cooldown_until: 13000, consecutive_errors: 1, last_error: 'rate_limit' });
});

test('quota -> exhausted with long cooldown', () => {
  const { db, id } = seed();
  applyError(db, id, { retryable: true, reason: 'quota' }, 1000);
  expect(state(db, id)).toMatchObject({ status: 'exhausted', cooldown_until: 1000 + QUOTA_COOLDOWN_MS });
});

test('auth -> disabled, no cooldown', () => {
  const { db, id } = seed();
  applyError(db, id, { retryable: true, reason: 'auth' }, 1000);
  expect(state(db, id)).toMatchObject({ status: 'disabled', cooldown_until: null });
});

test('server -> cooling with backoff', () => {
  const { db, id } = seed();
  applyError(db, id, { retryable: true, reason: 'server' }, 1000);
  const s = state(db, id) as any;
  expect(s.status).toBe('cooling');
  expect(s.cooldown_until).toBe(1000 + backoff(1));
});

test('bad_request and unknown do not change state', () => {
  const { db, id } = seed();
  applyError(db, id, { retryable: false, reason: 'bad_request' }, 1000);
  applyError(db, id, { retryable: true, reason: 'unknown' }, 1000);
  expect(state(db, id)).toMatchObject({ status: 'unknown', consecutive_errors: 0 });
});

test('applySuccess resets to healthy', () => {
  const { db, id } = seed();
  applyError(db, id, { retryable: true, reason: 'server' }, 1000);
  applySuccess(db, id, 2000);
  expect(state(db, id)).toMatchObject({ status: 'healthy', consecutive_errors: 0, cooldown_until: null });
});

test('backoff grows and caps', () => {
  expect(backoff(1)).toBeLessThan(backoff(3));
  expect(backoff(100)).toBe(BACKOFF_CAP_MS);
});
