import { buildApp } from './server';
import { openDb, applySchema } from './data/db';
import { seedGatewayKey } from './ingress/auth';

const masterKeyHex = process.env.MASTER_KEY ?? '';
if (masterKeyHex.length !== 64) throw new Error('MASTER_KEY must be 64 hex chars (32 bytes)');

const db = openDb(process.env.DB_PATH ?? './mixapi.sqlite');
applySchema(db);
if (process.env.GATEWAY_KEY) seedGatewayKey(db, process.env.GATEWAY_KEY);

const app = buildApp({ db, masterKeyHex });
const port = Number(process.env.PORT ?? 8080);
console.log(`mixapi listening on :${port}`);
export default { port, fetch: app.fetch };
