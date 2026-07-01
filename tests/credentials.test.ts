import { test, expect } from 'bun:test';
import { encryptSecret } from '../src/credentials/crypto';
import { StaticKeyCredential } from '../src/credentials/static-key';

const KEY = 'a'.repeat(64);

test('StaticKeyCredential returns decrypted api key', async () => {
  const enc = encryptSecret('sk-upstream-xyz', KEY);
  const cred = new StaticKeyCredential(enc, KEY);
  expect(await cred.getApiKey()).toBe('sk-upstream-xyz');
});
