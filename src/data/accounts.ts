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

export interface AccountState {
  status: string; cooldownUntil: number | null; consecutiveErrors: number;
  lastUsedAt: number | null; lastError: string | null;
}
export interface AccountWithState extends ResolvedAccount { enabled: boolean; state: AccountState; }
export interface AccountPatch { baseUrl?: string; models?: ModelMap[]; weight?: number; enabled?: boolean; egress?: string | null; }

interface AdminRow extends AccountRow {
  enabled: number; status: string | null; cooldown_until: number | null;
  consecutive_errors: number | null; last_used_at: number | null; last_error: string | null;
}

export function listAccountsWithState(db: Database): AccountWithState[] {
  const rows = db.query(
    `SELECT a.id,a.name,a.provider,a.adapter,a.base_url,a.models,a.weight,a.egress,a.enabled,
            s.status,s.cooldown_until,s.consecutive_errors,s.last_used_at,s.last_error
     FROM accounts a LEFT JOIN account_state s ON s.account_id = a.id
     ORDER BY a.created_at ASC`
  ).all() as AdminRow[];
  return rows.map((r) => ({
    ...rowToResolved(r), enabled: r.enabled === 1,
    state: {
      status: r.status ?? 'unknown', cooldownUntil: r.cooldown_until,
      consecutiveErrors: r.consecutive_errors ?? 0, lastUsedAt: r.last_used_at, lastError: r.last_error,
    },
  }));
}

export function updateAccount(db: Database, id: string, patch: AccountPatch): void {
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  if (patch.baseUrl !== undefined) { sets.push('base_url=?'); vals.push(patch.baseUrl); }
  if (patch.models !== undefined) { sets.push('models=?'); vals.push(JSON.stringify(patch.models)); }
  if (patch.weight !== undefined) { sets.push('weight=?'); vals.push(patch.weight); }
  if (patch.enabled !== undefined) { sets.push('enabled=?'); vals.push(patch.enabled ? 1 : 0); }
  if (patch.egress !== undefined) { sets.push('egress=?'); vals.push(patch.egress); }
  sets.push('updated_at=?'); vals.push(Date.now());
  db.query(`UPDATE accounts SET ${sets.join(', ')} WHERE id=?`).run(...vals, id);
}

export function deleteAccount(db: Database, id: string): void {
  db.transaction(() => {
    db.query('DELETE FROM credentials WHERE account_id=?').run(id);
    db.query('DELETE FROM account_state WHERE account_id=?').run(id);
    db.query('DELETE FROM accounts WHERE id=?').run(id);
  })();
}

export function setCredential(db: Database, accountId: string, secretEnc: Uint8Array): void {
  db.query('UPDATE credentials SET secret_enc=? WHERE account_id=?').run(secretEnc, accountId);
}

export function resetCooldown(db: Database, id: string): void {
  db.query(
    `UPDATE account_state SET status='unknown', cooldown_until=NULL, consecutive_errors=0 WHERE account_id=?`
  ).run(id);
}
