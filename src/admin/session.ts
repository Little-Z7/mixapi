import { createHmac, timingSafeEqual } from 'node:crypto';
import { hashKey } from '../ingress/auth';

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function secret(adminKey: string): string {
  return hashKey('session:' + adminKey);
}

export function signSession(adminKey: string, now: number = Date.now()): string {
  const exp = now + SESSION_TTL_MS;
  const mac = createHmac('sha256', secret(adminKey)).update(String(exp)).digest('hex');
  return `${exp}.${mac}`;
}

export function verifySession(adminKey: string, token: string | undefined, now: number = Date.now()): boolean {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const expStr = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= now) return false;
  const expected = createHmac('sha256', secret(adminKey)).update(expStr).digest('hex');
  if (mac.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
}
