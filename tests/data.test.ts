import { test, expect } from 'bun:test';
import { openDb, applySchema } from '../src/data/db';
import { insertAccount, listEnabledAccountsForModel, listPublicModels } from '../src/data/accounts';

function freshDb() {
  const db = openDb(':memory:');
  applySchema(db);
  return db;
}

test('insert + list account by public model', () => {
  const db = freshDb();
  const id = insertAccount(db, {
    name: 'glm-1', provider: 'glm', adapter: 'openai',
    baseUrl: 'https://example.test/v1',
    models: [{ public: 'glm-4.6', target: 'glm-4.6' }],
    weight: 1, egress: null, secretEnc: new Uint8Array([1, 2, 3]),
  });
  expect(id).toBeTruthy();

  const rows = listEnabledAccountsForModel(db, 'glm-4.6');
  expect(rows.length).toBe(1);
  expect(rows[0].name).toBe('glm-1');
  expect(rows[0].models[0].target).toBe('glm-4.6');
  expect(Array.from(rows[0].secretEnc)).toEqual([1, 2, 3]);

  expect(listEnabledAccountsForModel(db, 'nope')).toEqual([]);
  expect(listPublicModels(db)).toEqual(['glm-4.6']);
});
