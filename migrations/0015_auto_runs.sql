-- Issues an owner labelled dovre:auto (#207): each one's turn at an unattended sandbox run, from
-- queued to done or stuck. Kept here so a restart (or another Worker isolate) picks up where it was.
CREATE TABLE auto_runs (
  key TEXT PRIMARY KEY,          -- owner/name#number
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL,           -- queued | starting | running | waiting | done | stuck | refused
  run TEXT,                      -- the run's id on its machine
  cost REAL NOT NULL DEFAULT 0,
  why TEXT,
  pr TEXT,                       -- the draft PR's URL
  seen TEXT,                     -- the issue's updated_at when it was last checked
  options TEXT,                  -- the issue's own options block, as JSON
  at INTEGER NOT NULL,           -- when it was queued
  updated INTEGER NOT NULL
);
CREATE INDEX auto_runs_state ON auto_runs (state);
