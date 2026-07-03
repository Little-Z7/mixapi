import { existsSync } from 'node:fs';
import { buildApp } from './server';
import { openDb, applySchema } from './data/db';
import { seedGatewayKey } from './ingress/auth';
import { loadConfig, importAccounts } from './config/load';

const masterKeyHex = process.env.MASTER_KEY ?? '';
if (masterKeyHex.length !== 64) throw new Error('MASTER_KEY must be 64 hex chars (32 bytes)');

const db = openDb(process.env.DB_PATH ?? './mixapi.sqlite');
applySchema(db);
if (process.env.GATEWAY_KEY) seedGatewayKey(db, process.env.GATEWAY_KEY);

const cfgPath = process.env.CONFIG_PATH ?? './config.json';
if (existsSync(cfgPath)) {
  const { imported, skipped } = importAccounts(db, loadConfig(cfgPath), masterKeyHex);
  console.log(`config: imported ${imported.length} account(s), skipped ${skipped.length}`);
}

const adminKey = process.env.ADMIN_KEY;
const app = buildApp({ db, masterKeyHex, adminKey });
const port = Number(process.env.PORT ?? 8080);
console.log(`mixapi listening on :${port}`);
if (adminKey) console.log('admin console enabled at /admin');
export default { port, fetch: app.fetch };
