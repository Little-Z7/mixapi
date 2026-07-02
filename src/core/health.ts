import type { Database } from 'bun:sqlite';
import type { ErrorClassification } from '../adapters/types';

export const BACKOFF_BASE_MS = 5000;
export const BACKOFF_CAP_MS = 300000;
export const QUOTA_COOLDOWN_MS = 3600000;

export function backoff(consecutiveErrors: number): number {
  const exp = Math.min(Math.max(consecutiveErrors, 0), 6);
  return Math.min(BACKOFF_BASE_MS * 2 ** exp, BACKOFF_CAP_MS);
}

export function applyError(
  db: Database, accountId: string, cls: ErrorClassification, now: number = Date.now()
): void {
  if (cls.reason === 'bad_request' || cls.reason === 'unknown') return; // not the account's fault

  const row = db.query('SELECT consecutive_errors FROM account_state WHERE account_id = ?')
    .get(accountId) as { consecutive_errors: number } | null;
  const n = (row?.consecutive_errors ?? 0) + 1;

  let status: string;
  let cooldownUntil: number | null;
  if (cls.reason === 'rate_limit') { status = 'cooling'; cooldownUntil = now + (cls.cooldownMs ?? backoff(n)); }
  else if (cls.reason === 'quota') { status = 'exhausted'; cooldownUntil = now + QUOTA_COOLDOWN_MS; }
  else if (cls.reason === 'auth') { status = 'disabled'; cooldownUntil = null; }
  else { status = 'cooling'; cooldownUntil = now + backoff(n); } // 'server'

  db.query(
    `UPDATE account_state SET status=?, cooldown_until=?, consecutive_errors=?, last_error=?, last_checked_at=?
     WHERE account_id=?`
  ).run(status, cooldownUntil, n, cls.reason, now, accountId);
}

export function applySuccess(db: Database, accountId: string, now: number = Date.now()): void {
  db.query(
    `UPDATE account_state SET status='healthy', consecutive_errors=0, cooldown_until=NULL, last_used_at=?, last_checked_at=?
     WHERE account_id=?`
  ).run(now, now, accountId);
}
