import type { ResolvedAccount } from '../data/accounts';

export interface ChatMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; name?: string; }
export interface ChatRequest { model: string; messages: ChatMessage[]; stream: boolean; [k: string]: unknown; }
export interface ChatResponse { [k: string]: unknown; }

export interface UpstreamRequest { url: string; headers: Record<string, string>; body: string; }

export type ErrorReason = 'rate_limit' | 'quota' | 'auth' | 'server' | 'bad_request' | 'unknown';
export interface ErrorClassification { retryable: boolean; reason: ErrorReason; cooldownMs?: number; }

export interface ProviderAdapter {
  name: string;
  buildRequest(req: ChatRequest, account: ResolvedAccount, apiKey: string): UpstreamRequest;
  parseResponse(status: number, body: unknown): ChatResponse;
  translateStreamChunk(rawData: string): string[];
  classifyError(status: number, body: unknown, headers: Headers): ErrorClassification;
}

export function mapModel(publicModel: string, account: ResolvedAccount): string {
  return account.models.find((m) => m.public === publicModel)?.target ?? publicModel;
}

export function joinPath(base: string, path: string): string {
  return base.replace(/\/+$/, '') + path;
}
