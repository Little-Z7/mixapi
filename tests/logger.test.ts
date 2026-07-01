import { test, expect } from 'bun:test';
import { openDb, applySchema } from '../src/data/db';
import { logRequest, countLogs } from '../src/usage/logger';
import { estimateCost } from '../src/usage/cost';

test('estimateCost returns 0 for unknown model', () => {
  expect(estimateCost('unknown', 1000, 1000)).toBe(0);
});

test('logRequest writes a row', () => {
  const db = openDb(':memory:');
  applySchema(db);
  logRequest(db, {
    publicModel: 'glm-4.6', accountId: 'a1', status: 'ok', httpStatus: 200,
    latencyMs: 42, promptTokens: 10, completionTokens: 5, totalTokens: 15,
    estCost: 0, attemptCount: 1, stream: false,
  });
  expect(countLogs(db)).toBe(1);
});
