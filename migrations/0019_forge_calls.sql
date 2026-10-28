-- GitHub calls, counted (#253): an hour's calls by quota bucket and call site (a path template,
-- never a URL), and each bucket's quota as GitHub last said. Kept a week (src/forge/calls.ts).
CREATE TABLE IF NOT EXISTS forge_calls (
  hour INTEGER NOT NULL,
  bucket TEXT NOT NULL,
  site TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (hour, bucket, site)
);
CREATE TABLE IF NOT EXISTS forge_quota (
  bucket TEXT PRIMARY KEY,
  remaining INTEGER NOT NULL,
  lim INTEGER NOT NULL,
  reset INTEGER NOT NULL,
  at INTEGER NOT NULL
);
