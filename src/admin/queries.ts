import type { Database } from 'bun:sqlite';

export interface LogFilter {
  limit?: number; offset?: number;
  model?: string; account?: string; status?: string;
  sinceMs?: number; untilMs?: number; q?: string;
}
export interface LogPage { rows: Record<string, unknown>[]; total: number; }

export function listLogs(db: Database, f: LogFilter = {}): LogPage {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.model) { where.push('public_model = ?'); args.push(f.model); }
  if (f.account) { where.push('account_id = ?'); args.push(f.account); }
  if (f.status) { where.push('status = ?'); args.push(f.status); }
  if (Number.isFinite(f.sinceMs as number)) { where.push('ts >= ?'); args.push(f.sinceMs as number); }
  if (Number.isFinite(f.untilMs as number)) { where.push('ts <= ?'); args.push(f.untilMs as number); }
  if (f.q) {
    where.push('(public_model LIKE ? OR account_id LIKE ? OR status LIKE ?)');
    const like = `%${f.q}%`; args.push(like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(Number.isFinite(f.limit as number) ? (f.limit as number) : 100, 1), 1000);
  const offset = Math.max(Number.isFinite(f.offset as number) ? (f.offset as number) : 0, 0);
  const total = (db.query(`SELECT COUNT(*) AS n FROM request_logs ${clause}`).get(...args) as { n: number }).n;
  const rows = db.query(`SELECT * FROM request_logs ${clause} ORDER BY ts DESC LIMIT ${limit} OFFSET ${offset}`)
    .all(...args) as Record<string, unknown>[];
  return { rows, total };
}

export interface StatGroup { key: string; requests: number; errors: number; tokens: number; cost: number; }
export interface SeriesPoint { bucket: number; requests: number; errors: number; }
export interface Stats {
  totalRequests: number; errorCount: number; errorRate: number;
  totalTokens: number; totalCost: number;
  byModel: StatGroup[]; byAccount: StatGroup[]; byKey: StatGroup[];
  series: SeriesPoint[];
}

function groupBy(db: Database, column: string, since: number): StatGroup[] {
  return db.query(
    `SELECT COALESCE(${column}, '(none)') AS key,
            COUNT(*) AS requests,
            SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors,
            COALESCE(SUM(total_tokens),0) AS tokens,
            COALESCE(SUM(est_cost),0) AS cost
     FROM request_logs WHERE ts >= ? GROUP BY ${column} ORDER BY requests DESC`
  ).all(since) as StatGroup[];
}

// bucket width for the time series, derived from the requested span
export function bucketMsFor(sinceMs: number): number {
  const span = sinceMs > 0 ? Math.max(0, Date.now() - sinceMs) : Number.MAX_SAFE_INTEGER;
  if (span <= 2 * 3600e3) return 5 * 60e3;   // <= 2h  -> 5 min buckets
  if (span <= 2 * 86400e3) return 3600e3;    // <= 2d  -> 1 hour buckets
  return 86400e3;                            // else   -> 1 day buckets
}

function series(db: Database, sinceMs: number): SeriesPoint[] {
  const b = bucketMsFor(sinceMs);
  const rows = db.query(
    `SELECT CAST(ts / ? AS INTEGER) AS bucketIdx,
            COUNT(*) AS requests,
            SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors
     FROM request_logs WHERE ts >= ? GROUP BY bucketIdx ORDER BY bucketIdx`
  ).all(b, sinceMs) as { bucketIdx: number; requests: number; errors: number }[];
  return rows.map((r) => ({ bucket: r.bucketIdx * b, requests: r.requests, errors: r.errors }));
}

export function aggregateStats(db: Database, sinceMs: number = 0): Stats {
  const totals = db.query(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status='error' THEN 1 ELSE 0 END),0) AS errors,
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
    byKey: groupBy(db, 'gateway_key_id', sinceMs),
    series: series(db, sinceMs),
  };
}
