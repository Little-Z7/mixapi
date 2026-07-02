import type { ProviderAdapter } from './types';
import { openaiAdapter } from './openai';
import { anthropicAdapter } from './anthropic';

const REGISTRY: Record<string, ProviderAdapter> = {
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
};

export function getAdapter(name: string): ProviderAdapter {
  const a = REGISTRY[name];
  if (!a) throw new Error(`unknown adapter: ${name}`);
  return a;
}
