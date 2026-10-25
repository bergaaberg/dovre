-- AI summaries, keyed by what they summarize at a given commit, so they're made once per change.
CREATE TABLE summaries (
  key TEXT PRIMARY KEY,
  text TEXT,
  error TEXT,
  cost REAL,
  at TEXT NOT NULL
);
