-- 001_outbox.sql
-- Aplicada automáticamente al arrancar DatabaseService.
-- Conservada aquí como documentación de esquema.

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  event_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  event_time INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  payload_redacted TEXT NOT NULL,
  graph_payload TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  meta_response_redacted TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_status_next
  ON outbox_events(status, next_attempt_at);
