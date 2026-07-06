import { readFileSync } from 'node:fs';

// Read the self-contained page once at module load. Running Bun directly on the
// TS sources (no build step) means console.html sits beside this file at runtime.
export const CONSOLE_HTML: string = readFileSync(new URL('./console.html', import.meta.url), 'utf8');
