-- Bino's memory (memlet v0.1.0's SCHEMA_SQL): one-sentence facts per scope. Dovre has one
-- scope, the operator. Rows hold what memlet's checks let through: no secrets, no tool output.
CREATE TABLE IF NOT EXISTS memlet_memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'fact',
  source TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS memlet_memories_scope ON memlet_memories (scope, updated_at);
