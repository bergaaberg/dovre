-- What packs read from the owners' repos (#294): an answer by key (`every:<owners>:<paths>`,
-- `file:<repo>:<path>`, `repos:<owners>`), kept for every Worker isolate until it's too old for
-- whoever asks. Rows older than two days are dropped on the next write (src/sources/files.ts).
CREATE TABLE IF NOT EXISTS forge_reads (
  key TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  value TEXT NOT NULL
);
