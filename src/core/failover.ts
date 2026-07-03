import type { Database } from 'bun:sqlite';
import type { ChatRequest, ErrorReason, ProviderAdapter } from '../adapters/types';
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
  adapter?: string;
}

export async function routeAndCall(
  db: Database, req: ChatRequest, masterKeyHex: string, opts: RouteOpts = {}
): Promise<RouteOutcome> {
  const fetchFn = opts.fetchFn ?? fetch;
  const maxAttempts = opts.maxAttempts ?? 3;
  const candidates = listCandidates(db, req.model, Date.now(), opts.adapter);
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
    let adapter!: ProviderAdapter;
    let result: UpstreamResult;
    try {
      adapter = getAdapter(cand.adapter); // unknown adapter now rotates instead of aborting the request
      const apiKey = await new StaticKeyCredential(cand.secretEnc, masterKeyHex).getApiKey();
      const u = adapter.buildRequest(req, account, apiKey);
      result = await callUpstream(u, req.stream, fetchFn);
    } catch {
      applyError(db, cand.id, { retryable: true, reason: 'server' });
      lastError = { httpStatus: 502, reason: 'server' };
      continue;
    }

    // success requires the correct response shape for the request mode:
    // a stream request must get a stream; a non-stream request must get a non-error json
    if ((req.stream && result.stream) || (!req.stream && result.status < 400)) {
      applySuccess(db, cand.id);
      return { ok: true, result, account, attempts };
    }

    // stream requested but upstream returned a non-error response with no stream body
    // (bodyless 2xx) -> retryable server anomaly; rotate instead of false-committing
    if (result.status < 400) {
      applyError(db, cand.id, { retryable: true, reason: 'server' });
      lastError = { httpStatus: 502, reason: 'server' };
      continue;
    }

    const cls = adapter.classifyError(result.status, result.json, result.headers);
    applyError(db, cand.id, cls);
    lastError = { httpStatus: result.status, reason: cls.reason };
    if (!cls.retryable) break;
  }

  return { ok: false, attempts, lastError, account: lastAccount };
}
