import type { Candidate } from './pool';

// FNV-1a 32-bit, stable across runs
function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface SelectOpts {
  sessionId?: string;
  exclude?: Set<string>;
  rng?: () => number;
}

export function selectCandidate(candidates: Candidate[], opts: SelectOpts = {}): Candidate | null {
  const pool = opts.exclude ? candidates.filter((c) => !opts.exclude!.has(c.id)) : candidates;
  if (pool.length === 0) return null;

  if (opts.sessionId) {
    // Weighted rendezvous (HRW) hashing: sticky per session AND weight-proportional.
    // Each candidate scores weight / -ln(u), where u is a uniform hash of
    // (sessionId, candidate id) in (0,1); the highest score wins. Same key+pool
    // always picks the same account (cache affinity), P(pick=i) ∝ weight_i, and
    // dropping an account only remaps the keys that had chosen it.
    let best = pool[0];
    let bestScore = -Infinity;
    for (const c of pool) {
      const u = (hashStr(opts.sessionId + '::' + c.id) + 1) / 4294967297; // (0,1)
      const score = Math.max(1, c.weight) / -Math.log(u);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  }

  const rng = opts.rng ?? Math.random;
  const weights = pool.map((c) => Math.max(1, c.weight));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r < 0) return pool[i];
  }
  return pool[pool.length - 1]; // float-rounding fallback
}
