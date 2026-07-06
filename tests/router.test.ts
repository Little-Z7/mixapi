import { test, expect } from 'bun:test';
import { selectCandidate } from '../src/core/router';
import type { Candidate } from '../src/core/pool';

function cand(id: string, weight = 1): Candidate {
  return { id, name: id, provider: 'p', adapter: 'openai', baseUrl: '', models: [], weight,
    egress: null, secretEnc: new Uint8Array(), status: 'healthy' };
}

test('empty -> null', () => {
  expect(selectCandidate([])).toBeNull();
});

test('exclude removes tried, then null when all excluded', () => {
  const pool = [cand('a'), cand('b')];
  const picked = selectCandidate(pool, { exclude: new Set(['a']), rng: () => 0 });
  expect(picked?.id).toBe('b');
  expect(selectCandidate(pool, { exclude: new Set(['a', 'b']) })).toBeNull();
});

test('sessionId is sticky (same session -> same account)', () => {
  const pool = [cand('a'), cand('b'), cand('c')];
  const first = selectCandidate(pool, { sessionId: 'sess-42' })!.id;
  const again = selectCandidate(pool, { sessionId: 'sess-42' })!.id;
  expect(again).toBe(first);
});

test('weighted random honors injected rng', () => {
  const pool = [cand('a', 1), cand('b', 1)];
  expect(selectCandidate(pool, { rng: () => 0 })!.id).toBe('a');   // first band
  expect(selectCandidate(pool, { rng: () => 0.99 })!.id).toBe('b'); // last band
});

test('higher weight wins a mid-range draw', () => {
  const pool = [cand('a', 1), cand('b', 9)]; // total 10; draw at 0.5 -> 5 -> lands in b
  expect(selectCandidate(pool, { rng: () => 0.5 })!.id).toBe('b');
});

test('sticky is weight-proportional: heavy account gets the majority of conversations', () => {
  const pool = [cand('heavy', 20), cand('l1', 1), cand('l2', 1)]; // 20:1:1
  const counts: Record<string, number> = {};
  for (let i = 0; i < 200; i++) {
    const id = selectCandidate(pool, { sessionId: 'conv-' + i })!.id;
    counts[id] = (counts[id] ?? 0) + 1;
  }
  expect(counts.heavy).toBeGreaterThan((counts.l1 ?? 0) + (counts.l2 ?? 0));
});

test('sticky with equal weights spreads conversations across all accounts', () => {
  const pool = [cand('a'), cand('b'), cand('c')];
  const seen = new Set<string>();
  for (let i = 0; i < 60; i++) seen.add(selectCandidate(pool, { sessionId: 'c-' + i })!.id);
  expect(seen.size).toBe(3);
});

test('sticky + exclude: a downed account remaps to a stable alternative (failover keeps affinity)', () => {
  const pool = [cand('a'), cand('b'), cand('c')];
  const key = 'sticky-key';
  const chosen = selectCandidate(pool, { sessionId: key })!.id;
  const alt = selectCandidate(pool, { sessionId: key, exclude: new Set([chosen]) })!.id;
  expect(alt).not.toBe(chosen);
  for (let i = 0; i < 10; i++) {
    expect(selectCandidate(pool, { sessionId: key, exclude: new Set([chosen]) })!.id).toBe(alt);
  }
});
