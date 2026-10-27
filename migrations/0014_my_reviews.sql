-- My own review of a PR (dovre#106), kept here until I submit it: the commit it's on, its summary,
-- and its line comments. `who` is the person (hosted: the verified email; local: empty). Gone once
-- posted or discarded.
CREATE TABLE my_reviews (
  who TEXT NOT NULL,
  pr TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (who, pr)
);
CREATE TABLE my_review_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  who TEXT NOT NULL,
  pr TEXT NOT NULL,
  path TEXT NOT NULL,
  side TEXT NOT NULL,
  line INTEGER NOT NULL,
  start_line INTEGER,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX my_review_comments_pr ON my_review_comments (who, pr, id);
