import type { Database } from 'bun:sqlite';
import type { ResolvedAccount, ModelMap } from '../data/accounts';

export interface Candidate extends ResolvedAccount {
  secretEnc: Uint8Array;
  status: string;
}

interface Row {
  id: string; name: string; provider: string; adapter: string;
  base_url: string; models: string; weight: number; egress: string | null;
  secret_enc: Uint8Array; status: string | null;
}

export function listCandidates(db: Database, publicModel: string, now: number = Date.now(), adapter?: string): Candidate[] {
  const rows = db.query(
    `SELECT a.id,a.name,a.provider,a.adapter,a.base_url,a.models,a.weight,a.egress,
            c.secret_enc AS secret_enc, s.status AS status
     FROM accounts a
     JOIN credentials c ON c.account_id = a.id
     LEFT JOIN account_state s ON s.account_id = a.id
     WHERE a.enabled = 1
       AND COALESCE(s.status, 'unknown') != 'disabled'
       AND (s.cooldown_until IS NULL OR s.cooldown_until <= ?)
       AND (? IS NULL OR a.adapter = ?)`
  ).all(now, adapter ?? null, adapter ?? null) as Row[];
  return rows
    .map((r) => ({
      id: r.id, name: r.name, provider: r.provider, adapter: r.adapter,
      baseUrl: r.base_url, models: JSON.parse(r.models) as ModelMap[],
      weight: r.weight, egress: r.egress, secretEnc: r.secret_enc, status: r.status ?? 'unknown',
    }))
    .filter((c) => c.models.some((m) => m.public === publicModel));
}
