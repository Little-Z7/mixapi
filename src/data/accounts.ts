import type { Database } from 'bun:sqlite';

export interface ModelMap { public: string; target: string; }
export interface ResolvedAccount {
  id: string; name: string; provider: string; adapter: string;
  baseUrl: string; models: ModelMap[]; weight: number; egress: string | null;
}
export interface NewAccount {
  name: string; provider: string; adapter: string; baseUrl: string;
  models: ModelMap[]; weight: number; egress: string | null;
  secretEnc: Uint8Array; credType?: string;
}

interface AccountRow {
  id: string; name: string; provider: string; adapter: string;
  base_url: string; models: string; weight: number; egress: string | null;
}

function rowToResolved(r: AccountRow): ResolvedAccount {
  return {
    id: r.id, name: r.name, provider: r.provider, adapter: r.adapter,
    baseUrl: r.base_url, models: JSON.parse(r.models), weight: r.weight, egress: r.egress,
  };
}

export function insertAccount(db: Database, a: NewAccount): string {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.transaction(() => {
    db.query(
      `INSERT INTO accounts (id,name,provider,adapter,base_url,models,weight,enabled,egress,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,1,?,?,?)`
    ).run(id, a.name, a.provider, a.adapter, a.baseUrl, JSON.stringify(a.models), a.weight, a.egress, now, now);
    db.query(
      `INSERT INTO credentials (id,account_id,type,secret_enc,meta) VALUES (?,?,?,?,NULL)`
    ).run(crypto.randomUUID(), id, a.credType ?? 'static_key', a.secretEnc);
    db.query(
      `INSERT INTO account_state (account_id,status,consecutive_errors) VALUES (?, 'unknown', 0)`
    ).run(id);
  })();
  return id;
}

export function listEnabledAccountsForModel(
  db: Database, publicModel: string
): (ResolvedAccount & { secretEnc: Uint8Array })[] {
  const rows = db.query(
    `SELECT a.id,a.name,a.provider,a.adapter,a.base_url,a.models,a.weight,a.egress,
            c.secret_enc AS secret_enc
     FROM accounts a JOIN credentials c ON c.account_id = a.id
     WHERE a.enabled = 1`
  ).all() as (AccountRow & { secret_enc: Uint8Array })[];
  return rows
    .map((r) => ({ ...rowToResolved(r), secretEnc: r.secret_enc }))
    .filter((a) => a.models.some((m) => m.public === publicModel));
}

export function listPublicModels(db: Database): string[] {
  const rows = db.query(`SELECT models FROM accounts WHERE enabled = 1`).all() as { models: string }[];
  const set = new Set<string>();
  for (const r of rows) for (const m of JSON.parse(r.models) as ModelMap[]) set.add(m.public);
  return [...set];
}
