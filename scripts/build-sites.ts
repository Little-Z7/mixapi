import { mkdir, cp, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/server', { recursive: true });

const result = await Bun.build({
  entrypoints: ['src/sites-worker.ts'],
  outdir: 'dist/server',
  target: 'browser',
  format: 'esm',
  naming: 'index.js',
  minify: true,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

await mkdir('dist/.openai', { recursive: true });
await cp('.openai/hosting.json', 'dist/.openai/hosting.json');
await cp('.openai/drizzle', 'dist/.openai/drizzle', { recursive: true });
