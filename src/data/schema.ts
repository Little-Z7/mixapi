export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  adapter TEXT NOT NULL,
  base_url TEXT NOT NULL,
  models TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  egress TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  type TEXT NOT NULL,
  secret_enc BLOB NOT NULL,
  meta TEXT
);
CREATE TABLE IF NOT EXISTS account_state (
  account_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'unknown',
  cooldown_until INTEGER,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  last_error TEXT,
  last_checked_at INTEGER
);
CREATE TABLE IF NOT EXISTS request_logs (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  gateway_key_id TEXT,
  public_model TEXT,
  account_id TEXT,
  status TEXT NOT NULL,
  http_status INTEGER,
  latency_ms INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  est_cost REAL,
  attempt_count INTEGER,
  stream INTEGER,
  client_ip TEXT
);
CREATE TABLE IF NOT EXISTS gateway_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  name TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
`;
