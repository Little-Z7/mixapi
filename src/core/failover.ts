import type { Database } from 'bun:sqlite';
import type { ChatRequest, ErrorReason } from '../adapters/types';
import type { ResolvedAccount } from '../data/accounts';
import { listCandidates } from './pool';
import { selectCandidate } from './router';
import { applyError, applySuccess } from './health';
import { StaticKeyCredential } from '../credentials/static-key';
import { getAdapter } from '../adapters/registry';
import { callUpstream, type UpstreamResult } from './upstream';

export interface RouteOutcome {
  ok: boolean;
  result?: UpstreamResult;
  account?: ResolvedAccount;
  attempts: number;
  lastError?: { httpStatus: number; reason: ErrorReason };
  noCandidates?: boolean;
}

export interface RouteOpts {
  fetchFn?: typeof fetch;
  sessionId?: string;
  maxAttempts?: number;
  rng?: () => number;
}

export async function routeAndCall(
  db: Database, req: ChatRequest, masterKeyHex: string, opts: RouteOpts = {}
): Promise<RouteOutcome> {
  const fetchFn = opts.fetchFn ?? fetch;
  const maxAttempts = opts.maxAttempts ?? 3;
  const candidates = listCandidates(db, req.model);
  if (candidates.length === 0) return { ok: false, attempts: 0, noCandidates: true };

  const tried = new Set<string>();
  let attempts = 0;
  let lastError: { httpStatus: number; reason: ErrorReason } | undefined;
  let lastAccount: ResolvedAccount | undefined;

  while (attempts < maxAttempts) {
    const cand = selectCandidate(candidates, { sessionId: opts.sessionId, exclude: tried, rng: opts.rng });
    if (!cand) break;
    tried.add(cand.id);
    attempts++;

    const { secretEnc, status, ...account } = cand; // strip pool-only fields
    lastAccount = account;
    const adapter = getAdapter(cand.adapter);
    let result: UpstreamResult;
    try {
      const apiKey = await new StaticKeyCredential(cand.secretEnc, masterKeyHex).getApiKey();
      const u = adapter.buildRequest(req, account, apiKey);
      result = await callUpstream(u, req.stream, fetchFn);
    } catch {
      applyError(db, cand.id, { retryable: true, reason: 'server' });
      lastError = { httpStatus: 502, reason: 'server' };
      continue;
    }

    if (result.stream || result.status < 400) {
      applySuccess(db, cand.id);
      return { ok: true, result, account, attempts };
    }

    const cls = adapter.classifyError(result.status, result.json, result.headers);
    applyError(db, cand.id, cls);
    lastError = { httpStatus: result.status, reason: cls.reason };
    if (!cls.retryable) break;
  }

  return { ok: false, attempts, lastError, account: lastAccount };
}
