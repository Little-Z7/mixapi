import { test, expect } from 'bun:test';
import { encryptSecret, decryptSecret } from '../src/credentials/crypto';

const KEY = 'a'.repeat(64); // 32 bytes hex

test('encrypt/decrypt round-trip', () => {
  const blob = encryptSecret('sk-secret-123', KEY);
  expect(blob.length).toBeGreaterThan(28);
  expect(decryptSecret(blob, KEY)).toBe('sk-secret-123');
});

test('wrong key fails to decrypt', () => {
  const blob = encryptSecret('sk-secret-123', KEY);
  expect(() => decryptSecret(blob, 'b'.repeat(64))).toThrow();
});

test('tampered ciphertext fails', () => {
  const blob = encryptSecret('sk-secret-123', KEY);
  blob[blob.length - 1] ^= 0xff;
  expect(() => decryptSecret(blob, KEY)).toThrow();
});
