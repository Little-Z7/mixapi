import { test, expect } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { openDb, applySchema } from '../src/data/db';
import { logRequest } from '../src/usage/logger';
import { listLogs, aggregateStats } from '../src/admin/queries';

function seed() {
  const db = openDb(':memory:'); applySchema(db);
  logRequest(db, { publicModel: 'm1', accountId: 'a1', status: 'ok', httpStatus: 200, totalTokens: 10, estCost: 0.01, attemptCount: 1 });
  logRequest(db, { publicModel: 'm1', accountId: 'a1', status: 'error', httpStatus: 429, totalTokens: 0, estCost: 0, attemptCount: 2 });
  logRequest(db, { publicModel: 'm2', accountId: 'a2', status: 'ok', httpStatus: 200, totalTokens: 5, estCost: 0.02, attemptCount: 1 });
  return db;
}

// raw insert with a chosen ts / gateway_key_id for time- and key-based tests
function insLog(db: Database, ts: number, o: { key?: string; model?: string; account?: string; status?: string } = {}) {
  db.query(`INSERT INTO request_logs (id,ts,gateway_key_id,public_model,account_id,status,http_status,total_tokens,est_cost,attempt_count,stream)
            VALUES (?,?,?,?,?,?,?,?,?,?,0)`)
    .run(crypto.randomUUID(), ts, o.key ?? null, o.model ?? 'm', o.account ?? 'a', o.status ?? 'ok', 200, 0, 0, 1);
}

test('listLogs filters by status and model, newest first; returns {rows,total}', () => {
  const db = seed();
  expect(listLogs(db, { status: 'error' }).rows.length).toBe(1);
  expect(listLogs(db, { model: 'm1' }).rows.length).toBe(2);
  const page = listLogs(db, { limit: 2 });
  expect(page.rows.length).toBe(2);
  expect(page.total).toBe(3);
});

test('listLogs time range, pagination and search', () => {
  const db = openDb(':memory:'); applySchema(db);
  insLog(db, 1000, { model: 'gpt-x' });
  insLog(db, 2000, { model: 'glm-x' });
  insLog(db, 3000, { model: 'glm-y' });
  expect(listLogs(db, { sinceMs: 2000 }).total).toBe(2);
  expect(listLogs(db, { untilMs: 2000 }).total).toBe(2);
  expect(listLogs(db, { sinceMs: 2000, untilMs: 2000 }).total).toBe(1);
  // pagination: total reflects all matches, rows respect limit/offset
  const p1 = listLogs(db, { limit: 2, offset: 0 });
  expect(p1.total).toBe(3); expect(p1.rows.length).toBe(2);
  expect(listLogs(db, { limit: 2, offset: 2 }).rows.length).toBe(1);
  // search across model/account/status
  expect(listLogs(db, { q: 'glm' }).total).toBe(2);
  expect(listLogs(db, { q: 'gpt' }).total).toBe(1);
});

test('aggregateStats totals, error rate and grouping (byModel/byAccount/byKey)', () => {
  const db = seed();
  insLog(db, Date.now(), { key: 'k1' });
  insLog(db, Date.now(), { key: 'k1' });
  insLog(db, Date.now(), { key: 'k2' });
  const s = aggregateStats(db);
  expect(s.totalRequests).toBe(6);
  expect(s.byModel.find((g) => g.key === 'm1')!.requests).toBe(2);
  expect(s.byAccount.find((g) => g.key === 'a2')!.tokens).toBe(5);
  expect(s.byKey.find((g) => g.key === 'k1')!.requests).toBe(2);
  expect(s.byKey.find((g) => g.key === '(none)')!.requests).toBe(3); // the seed() rows have no key
});

test('aggregateStats series buckets by day for a wide span', () => {
  const db = openDb(':memory:'); applySchema(db);
  const DAY = 86400e3;
  insLog(db, DAY);            // day 1
  insLog(db, DAY * 3);       // day 3
  insLog(db, DAY * 3 + 50);  // day 3 again
  const s = aggregateStats(db, 0); // sinceMs=0 → day buckets
  expect(s.series.length).toBe(2);
  expect(s.series.reduce((a, p) => a + p.requests, 0)).toBe(3);
});

test('aggregateStats on an empty table returns numeric zeros (not null)', () => {
  const db = openDb(':memory:'); applySchema(db);
  const s = aggregateStats(db);
  expect(s.totalRequests).toBe(0);
  expect(s.errorCount).toBe(0);
  expect(s.errorRate).toBe(0);
  expect(s.byKey).toEqual([]);
  expect(s.series).toEqual([]);
});

test('listLogs with a non-numeric limit does not throw (defaults)', () => {
  const db = seed();
  expect(() => listLogs(db, { limit: Number('nope') })).not.toThrow();
});
