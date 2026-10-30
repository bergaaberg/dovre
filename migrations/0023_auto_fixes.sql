-- Fix sessions on auto PRs (#326): sandbox runs Auto review asks the agents pack for. They take
-- the same at-once slot as auto runs (a claim counts both tables) and count toward the day's cap
-- (their cost goes in auto_spend under the issue's key).
CREATE TABLE auto_fixes (
  id TEXT PRIMARY KEY,           -- the slot's claim
  key TEXT NOT NULL,             -- the auto run's issue, owner/name#number
  pr TEXT NOT NULL,              -- the PR it fixes
  state TEXT NOT NULL,           -- starting | running | ended
  run TEXT,                      -- the run's id on its machine, once started
  cost REAL NOT NULL DEFAULT 0,
  at INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX auto_fixes_state ON auto_fixes (state);
