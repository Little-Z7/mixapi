import type { Database } from 'bun:sqlite';
import { listEnabledAccountsForModel, type ResolvedAccount } from '../data/accounts';
import { StaticKeyCredential } from '../credentials/static-key';

export interface Selection { account: ResolvedAccount; apiKey: string; }

export async function selectAccountForModel(
  db: Database, publicModel: string, masterKeyHex: string
): Promise<Selection | null> {
  const candidates = listEnabledAccountsForModel(db, publicModel);
  if (candidates.length === 0) return null;
  const chosen = candidates[0];
  const apiKey = await new StaticKeyCredential(chosen.secretEnc, masterKeyHex).getApiKey();
  const { secretEnc, ...account } = chosen;
  return { account, apiKey };
}
