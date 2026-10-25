-- Agent reviews of PRs (WP-A3): which run and session reviewed which PR at which head commit.
-- The report itself isn't kept here: it's the session's own last message, read from the run or
-- its transcript like the session page does.
CREATE TABLE agent_reviews (
  run_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  pr TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  harness TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX agent_reviews_pr ON agent_reviews (pr, started_at);
