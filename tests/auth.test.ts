import { test, expect } from 'bun:test';
import { openDb, applySchema } from '../src/data/db';
import { seedGatewayKey, verifyGatewayKey } from '../src/ingress/auth';

function db() { const d = openDb(':memory:'); applySchema(d); return d; }

test('verifies a seeded key, rejects others', () => {
  const d = db();
  seedGatewayKey(d, 'gw-secret');
  seedGatewayKey(d, 'gw-secret'); // idempotent, no throw
  expect(verifyGatewayKey(d, 'Bearer gw-secret')).toBe(true);
  expect(verifyGatewayKey(d, 'Bearer wrong')).toBe(false);
  expect(verifyGatewayKey(d, undefined)).toBe(false);
  expect(verifyGatewayKey(d, 'gw-secret')).toBe(false); // missing Bearer
});
