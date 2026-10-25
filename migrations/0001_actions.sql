-- Every write Dovre made on my behalf, whether it worked or not.
CREATE TABLE actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT,
  ok INTEGER NOT NULL,
  error TEXT
);
CREATE INDEX actions_at ON actions (at);
