import { test, expect } from 'bun:test';
import { openDb, applySchema } from '../src/data/db';
import { insertAccount } from '../src/data/accounts';
import { encryptSecret } from '../src/credentials/crypto';
import { selectAccountForModel } from '../src/core/select';

const KEY = 'a'.repeat(64);

test('selects account and decrypts key', async () => {
  const db = openDb(':memory:');
  applySchema(db);
  insertAccount(db, {
    name: 'glm', provider: 'glm', adapter: 'openai', baseUrl: 'https://x.test/v1',
    models: [{ public: 'glm-4.6', target: 'glm-4.6' }], weight: 1, egress: null,
    secretEnc: encryptSecret('sk-up', KEY),
  });
  const sel = await selectAccountForModel(db, 'glm-4.6', KEY);
  expect(sel?.account.name).toBe('glm');
  expect(sel?.apiKey).toBe('sk-up');
  expect(await selectAccountForModel(db, 'missing', KEY)).toBeNull();
});
