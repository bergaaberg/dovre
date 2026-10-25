-- My list: small things and small initiatives that live nowhere else (not Jira, not GHE).
-- An item with items under it (parent) is an initiative; one level deep.
CREATE TABLE todo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent INTEGER,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'next',
  due TEXT,
  pos REAL NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  done_at INTEGER
);
CREATE INDEX todo_parent ON todo (parent, pos);
