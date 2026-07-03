import type { Database } from 'bun:sqlite';
import { createHash, randomBytes } from 'node:crypto';

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

export interface GatewayKeyInfo {
  id: string; name: string | null; keyHashPrefix: string; enabled: boolean; createdAt: number;
}

export function listGatewayKeys(db: Database): GatewayKeyInfo[] {
  const rows = db.query('SELECT id,name,key_hash,enabled,created_at FROM gateway_keys ORDER BY created_at ASC')
    .all() as { id: string; name: string | null; key_hash: string; enabled: number; created_at: number }[];
  return rows.map((r) => ({
    id: r.id, name: r.name, keyHashPrefix: r.key_hash.slice(0, 8), enabled: r.enabled === 1, createdAt: r.created_at,
  }));
}

export function createGatewayKey(db: Database, name: string): { id: string; key: string } {
  const key = 'mk-' + randomBytes(24).toString('hex');
  const id = crypto.randomUUID();
  db.query('INSERT INTO gateway_keys (id,key_hash,name,enabled,created_at) VALUES (?,?,?,1,?)')
    .run(id, hashKey(key), name, Date.now());
  return { id, key };
}

export function deleteGatewayKey(db: Database, id: string): void {
  db.query('DELETE FROM gateway_keys WHERE id=?').run(id);
}
