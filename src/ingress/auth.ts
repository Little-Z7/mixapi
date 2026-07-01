import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';

export function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function seedGatewayKey(db: Database, rawKey: string, name = 'bootstrap'): void {
  const h = hashKey(rawKey);
  const existing = db.query(`SELECT id FROM gateway_keys WHERE key_hash = ?`).get(h);
  if (existing) return;
  db.query(`INSERT INTO gateway_keys (id,key_hash,name,enabled,created_at) VALUES (?,?,?,1,?)`)
    .run(crypto.randomUUID(), h, name, Date.now());
}

export function verifyGatewayKey(db: Database, authHeader: string | undefined): boolean {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  const raw = authHeader.slice('Bearer '.length).trim();
  if (!raw) return false;
  const row = db.query(`SELECT enabled FROM gateway_keys WHERE key_hash = ?`).get(hashKey(raw)) as
    | { enabled: number }
    | null;
  return !!row && row.enabled === 1;
}
