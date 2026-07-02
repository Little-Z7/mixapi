import { readFileSync } from 'node:fs';
import type { Database } from 'bun:sqlite';
import { insertAccount } from '../data/accounts';
import { encryptSecret } from '../credentials/crypto';

export interface AccountConfig {
  name: string; provider: string; adapter: string; baseUrl: string;
  keyEnv: string; models: { public: string; target: string }[]; weight?: number;
}
export interface MixConfig { accounts: AccountConfig[]; }

export function loadConfig(path: string): MixConfig {
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as MixConfig;
  if (!Array.isArray(cfg.accounts)) throw new Error('config: "accounts" must be an array');
  return cfg;
}

export function importAccounts(
  db: Database, cfg: MixConfig, masterKeyHex: string,
  env: Record<string, string | undefined> = process.env
): { imported: string[]; skipped: string[] } {
  const imported: string[] = [];
  const skipped: string[] = [];
  for (const a of cfg.accounts) {
    if (db.query('SELECT id FROM accounts WHERE name = ?').get(a.name)) { skipped.push(a.name); continue; }
    const key = env[a.keyEnv];
    if (!key) throw new Error(`config: env ${a.keyEnv} is not set for account ${a.name}`);
    insertAccount(db, {
      name: a.name, provider: a.provider, adapter: a.adapter, baseUrl: a.baseUrl,
      models: a.models, weight: a.weight ?? 1, egress: null,
      secretEnc: encryptSecret(key, masterKeyHex),
    });
    imported.push(a.name);
  }
  return { imported, skipped };
}
