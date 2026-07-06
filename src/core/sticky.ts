// Prefix-derived stickiness.
//
// Prompt caching is per-account (per API key / org). When a client sends no
// x-session-id, the router falls back to weighted-random selection, so a
// conversation's follow-up requests scatter across accounts and miss the
// prompt cache a *different* account warmed on the first turn.
//
// deriveStickyKey builds a stable key that identifies the CONVERSATION and
// feeds it to the same consistent hash the x-session-id path uses, pinning one
// conversation to one account so its prompt cache keeps hitting — with zero
// client changes. We key on `tools` + the FIRST user message, both constant
// across a conversation's turns. We deliberately DO NOT key on the system
// prompt: coding agents (Claude Code, etc.) inject volatile content there
// (date, cwd, git status, reminder blocks) that changes turn-to-turn and would
// thrash the routing, defeating the cache benefit. Different conversations
// (different first message) still spread across accounts.
//
// Trade-offs (acceptable for small-team pooling; both degrade to the
// pre-feature weighted-random baseline, never worse):
//  - If a client rewrites its first user message mid-conversation (aggressive
//    context pruning), the key changes and the conversation may re-pin.
//  - Distinct callers sending identical tools + first message hash to the same
//    account. A caller that needs explicit control can send x-session-id, which
//    always takes precedence over this derived key.

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

// Protocol-agnostic: OpenAI and Anthropic bodies both carry top-level `tools`
// and a `messages` array whose first role==='user' entry is the opening turn.
export function deriveStickyKey(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, any>;
  const str = (v: unknown) => {
    try { return typeof v === 'string' ? v : JSON.stringify(v); } catch { return ''; }
  };
  const msgs: any[] = Array.isArray(b.messages) ? b.messages : [];
  const firstUser = msgs.find((m) => m && m.role === 'user');
  const parts: string[] = [];
  if (b.tools != null) parts.push('t:' + str(b.tools));
  if (firstUser != null) parts.push('u:' + str(firstUser.content));
  if (parts.length === 0) return undefined;      // no stable signal -> weighted random
  return 'pfx:' + fnv1a(parts.join('::'));
}
