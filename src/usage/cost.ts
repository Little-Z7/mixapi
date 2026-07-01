// USD per 1M tokens. Illustrative defaults — treat as configurable; extend per public model.
const PRICE_MAP: Record<string, { in: number; out: number }> = {
  'glm-4.6': { in: 0.6, out: 2.2 },
};

export function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const p = PRICE_MAP[model];
  if (!p) return 0;
  return (promptTokens / 1e6) * p.in + (completionTokens / 1e6) * p.out;
}
