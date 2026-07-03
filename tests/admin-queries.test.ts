import { test, expect } from 'bun:test';
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

test('listLogs filters by status and model, newest first', () => {
  const db = seed();
  expect(listLogs(db, { status: 'error' }).length).toBe(1);
  expect(listLogs(db, { model: 'm1' }).length).toBe(2);
  expect(listLogs(db, { limit: 2 }).length).toBe(2);
});

test('aggregateStats totals, error rate and grouping', () => {
  const db = seed();
  const s = aggregateStats(db);
  expect(s.totalRequests).toBe(3);
  expect(s.errorCount).toBe(1);
  expect(s.errorRate).toBeCloseTo(1 / 3, 5);
  expect(s.totalTokens).toBe(15);
  expect(s.totalCost).toBeCloseTo(0.03, 5);
  expect(s.byModel.find((g) => g.key === 'm1')!.requests).toBe(2);
  expect(s.byAccount.find((g) => g.key === 'a2')!.tokens).toBe(5);
});

test('aggregateStats on an empty table returns numeric zeros (not null)', () => {
  const db = openDb(':memory:'); applySchema(db);
  const s = aggregateStats(db);
  expect(s.totalRequests).toBe(0);
  expect(s.errorCount).toBe(0);       // was null before the COALESCE fix
  expect(s.errorRate).toBe(0);
});

test('listLogs with a non-numeric limit does not throw (defaults)', () => {
  const db = seed();
  expect(() => listLogs(db, { limit: Number('nope') })).not.toThrow();
});
