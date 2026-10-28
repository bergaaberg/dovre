-- What each unattended run has spent (#234), one row per run, so the day's cap still counts a run
-- after its issue is relabelled or run again (auto_runs.cost only holds the newest run's cost).
CREATE TABLE auto_spend (
  key TEXT NOT NULL,             -- owner/name#number
  run TEXT NOT NULL,             -- the run's id on its machine
  cost REAL NOT NULL,
  at INTEGER NOT NULL,           -- when the cost was last reported
  PRIMARY KEY (key, run)
);
CREATE INDEX auto_spend_at ON auto_spend (at);
INSERT INTO auto_spend (key, run, cost, at) SELECT key, run, cost, updated FROM auto_runs WHERE run IS NOT NULL AND cost > 0;
