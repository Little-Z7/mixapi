import { test, expect } from 'bun:test';
import { openDb, applySchema } from '../src/data/db';
import { createGatewayKey, listGatewayKeys, deleteGatewayKey, verifyGatewayKey } from '../src/ingress/auth';

function db2() { const d = openDb(':memory:'); applySchema(d); return d; }

test('createGatewayKey returns a usable raw key, stores only the hash', () => {
  const db = db2();
  const { id, key } = createGatewayKey(db, 'ci');
  expect(id).toBeTruthy();
  expect(key).toMatch(/^mk-/);
  expect(verifyGatewayKey(db, `Bearer ${key}`)).toBe(true);      // the raw key works
  const stored = db.query('SELECT key_hash FROM gateway_keys WHERE id=?').get(id) as any;
  expect(stored.key_hash).not.toContain(key);                    // raw not stored
});

test('listGatewayKeys is masked (no raw key), shows hash prefix', () => {
  const db = db2();
  const { key } = createGatewayKey(db, 'ci');
  const list = listGatewayKeys(db);
  expect(list.length).toBe(1);
  expect(list[0].name).toBe('ci');
  expect(list[0].enabled).toBe(true);
  expect(list[0].keyHashPrefix.length).toBe(8);
  expect(JSON.stringify(list)).not.toContain(key);               // raw never present
});

test('deleteGatewayKey revokes it', () => {
  const db = db2();
  const { id, key } = createGatewayKey(db, 'ci');
  deleteGatewayKey(db, id);
  expect(verifyGatewayKey(db, `Bearer ${key}`)).toBe(false);
  expect(listGatewayKeys(db).length).toBe(0);
});
