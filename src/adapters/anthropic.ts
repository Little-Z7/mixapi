import type { ProviderAdapter, ChatRequest, ChatResponse, UpstreamRequest, ErrorClassification } from './types';
import { mapModel, joinPath } from './types';
import type { ResolvedAccount } from '../data/accounts';

export const anthropicAdapter: ProviderAdapter = {
  name: 'anthropic',
  buildRequest(req: ChatRequest, account: ResolvedAccount, apiKey: string): UpstreamRequest {
    const body = { ...req, model: mapModel(req.model, account) };
    return {
      url: joinPath(account.baseUrl, '/v1/messages'),
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        authorization: `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    };
  },
  parseResponse(_status: number, body: unknown): ChatResponse {
    return (body ?? {}) as ChatResponse;
  },
  translateStreamChunk(rawData: string): string[] {
    return [rawData];
  },
  classifyError(status: number, _body: unknown, headers: Headers): ErrorClassification {
    if (status === 429) {
      const ra = Number(headers.get('retry-after'));
      return { retryable: true, reason: 'rate_limit', cooldownMs: Number.isFinite(ra) ? ra * 1000 : 30000 };
    }
    if (status === 401 || status === 403) return { retryable: true, reason: 'auth' };
    if (status === 400) return { retryable: false, reason: 'bad_request' };
    if (status === 529 || status >= 500) return { retryable: true, reason: 'server', cooldownMs: 5000 };
    return { retryable: status >= 400, reason: 'unknown' };
  },
};
