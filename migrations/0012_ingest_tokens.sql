-- Ingest tokens (dovre#109): what an app shows to POST into a pack's /<id>/ingest/ (an OTLP sink).
-- Only the SHA-256 of each token is kept; the token itself is shown once, when it's made.
CREATE TABLE ingest_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pack TEXT NOT NULL,
  source TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX ingest_tokens_pack ON ingest_tokens (pack);
