import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALG = 'aes-256-gcm';

function key(masterKeyHex: string): Buffer {
  const k = Buffer.from(masterKeyHex, 'hex');
  if (k.length !== 32) throw new Error('MASTER_KEY must be 64 hex chars (32 bytes)');
  return k;
}

export function encryptSecret(plaintext: string, masterKeyHex: string): Uint8Array {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, key(masterKeyHex), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return new Uint8Array(Buffer.concat([iv, tag, ct]));
}

export function decryptSecret(blob: Uint8Array, masterKeyHex: string): string {
  const buf = Buffer.from(blob);
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv(ALG, key(masterKeyHex), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
