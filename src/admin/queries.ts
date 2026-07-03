import type { Database } from 'bun:sqlite';

export interface LogFilter { limit?: number; model?: string; account?: string; status?: string; }

export function listLogs(db: Database, f: LogFilter = {}): Record<string, unknown>[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.model) { where.push('public_model = ?'); args.push(f.model); }
  if (f.account) { where.push('account_id = ?'); args.push(f.account); }
  if (f.status) { where.push('status = ?'); args.push(f.status); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 1000);
  return db.query(`SELECT * FROM request_logs ${clause} ORDER BY ts DESC LIMIT ${limit}`)
    .all(...args) as Record<string, unknown>[];
}

export interface StatGroup { key: string; requests: number; errors: number; tokens: number; cost: number; }
export interface Stats {
  totalRequests: number; errorCount: number; errorRate: number;
  totalTokens: number; totalCost: number; byModel: StatGroup[]; byAccount: StatGroup[];
}

function groupBy(db: Database, column: string, since: number): StatGroup[] {
  const rows = db.query(
    `SELECT COALESCE(${column}, '(none)') AS key,
            COUNT(*) AS requests,
            SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors,
            COALESCE(SUM(total_tokens),0) AS tokens,
            COALESCE(SUM(est_cost),0) AS cost
     FROM request_logs WHERE ts >= ? GROUP BY ${column} ORDER BY requests DESC`
  ).all(since) as StatGroup[];
  return rows;
}

export function aggregateStats(db: Database, sinceMs: number = 0): Stats {
  const totals = db.query(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors,
            COALESCE(SUM(total_tokens),0) AS tokens,
            COALESCE(SUM(est_cost),0) AS cost
     FROM request_logs WHERE ts >= ?`
  ).get(sinceMs) as { total: number; errors: number; tokens: number; cost: number };
  return {
    totalRequests: totals.total, errorCount: totals.errors,
    errorRate: totals.total ? totals.errors / totals.total : 0,
    totalTokens: totals.tokens, totalCost: totals.cost,
    byModel: groupBy(db, 'public_model', sinceMs),
    byAccount: groupBy(db, 'account_id', sinceMs),
  };
}
