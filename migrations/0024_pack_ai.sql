-- What each pack may ask the model (#466): off until I allow it on Settings → Packs → the pack.
CREATE TABLE pack_ai (
  pack TEXT PRIMARY KEY,
  level TEXT NOT NULL,
  size TEXT NOT NULL DEFAULT 'small',
  day_usd REAL NOT NULL DEFAULT 1
);
-- Each call a pack made: when, what it cost, whether it answered. Never the prompt or the reply.
CREATE TABLE pack_ai_calls (
  pack TEXT NOT NULL,
  at TEXT NOT NULL,
  cost REAL NOT NULL,
  ok INTEGER NOT NULL
);
CREATE INDEX pack_ai_calls_pack_at ON pack_ai_calls (pack, at);
-- AI summaries were core's, on wherever a model could write them: they keep that as a pack.
INSERT INTO pack_ai (pack, level, size, day_usd) VALUES ('summaries', 'text', 'small', 1);
