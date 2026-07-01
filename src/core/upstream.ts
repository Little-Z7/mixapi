import type { UpstreamRequest } from '../adapters/types';

export interface UpstreamResult {
  status: number;
  headers: Headers;
  json?: unknown;
  stream?: ReadableStream<Uint8Array>;
}

export async function callUpstream(
  u: UpstreamRequest,
  stream: boolean,
  fetchFn: typeof fetch = fetch
): Promise<UpstreamResult> {
  const resp = await fetchFn(u.url, { method: 'POST', headers: u.headers, body: u.body });
  if (stream && resp.ok && resp.body) {
    return { status: resp.status, headers: resp.headers, stream: resp.body };
  }
  const text = await resp.text();
  let json: unknown;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = { raw: text }; }
  return { status: resp.status, headers: resp.headers, json };
}
