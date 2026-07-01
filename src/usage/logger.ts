import type { Database } from 'bun:sqlite';

export interface RequestLogEntry {
  gatewayKeyId?: string | null;
  publicModel?: string | null;
  accountId?: string | null;
  status: 'ok' | 'error' | 'failover';
  httpStatus?: number | null;
  latencyMs?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  estCost?: number | null;
  attemptCount?: number | null;
  stream?: boolean | null;
  clientIp?: string | null;
}

export function logRequest(db: Database, e: RequestLogEntry): void {
  db.query(
    `INSERT INTO request_logs
       (id,ts,gateway_key_id,public_model,account_id,status,http_status,latency_ms,
        prompt_tokens,completion_tokens,total_tokens,est_cost,attempt_count,stream,client_ip)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    crypto.randomUUID(), Date.now(), e.gatewayKeyId ?? null, e.publicModel ?? null,
    e.accountId ?? null, e.status, e.httpStatus ?? null, e.latencyMs ?? null,
    e.promptTokens ?? null, e.completionTokens ?? null, e.totalTokens ?? null,
    e.estCost ?? null, e.attemptCount ?? null, e.stream ? 1 : 0, e.clientIp ?? null
  );
}

export function countLogs(db: Database): number {
  return (db.query(`SELECT COUNT(*) AS n FROM request_logs`).get() as { n: number }).n;
}
