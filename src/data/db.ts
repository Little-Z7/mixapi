import { Database } from 'bun:sqlite';
import { SCHEMA_SQL } from './schema';

export function openDb(path: string): Database {
  const db = new Database(path);
  db.run('PRAGMA journal_mode = WAL;');
  db.run('PRAGMA foreign_keys = ON;');
  return db;
}

export function applySchema(db: Database): void {
  db.run(SCHEMA_SQL);
}

export type { Database };
