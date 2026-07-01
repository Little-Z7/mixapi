import { buildApp } from './server';

const app = buildApp();
const port = Number(process.env.PORT ?? 8080);
export default { port, fetch: app.fetch };
