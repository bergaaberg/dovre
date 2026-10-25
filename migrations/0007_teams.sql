-- Teams chats kept locally (src/teams/store.ts), so an agent on a Copilot model can look through
-- them for todos and reminders. What chats say (chat names, sender names, message text, what
-- was found) is sealed: AES-256-GCM under a key only this Windows account can unwrap (DPAPI,
-- data/teams.key). Ids and times stay plain, for sorting and paging.
CREATE TABLE teams_chat (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name_sealed TEXT NOT NULL,
  web_url TEXT,
  last_at TEXT,
  read_at TEXT,
  -- Newest message kept, and how far back history is in (backfill goes on from older_token).
  newest_at TEXT,
  older_token TEXT,
  backfilled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE teams_message (
  chat_id TEXT NOT NULL,
  id TEXT NOT NULL,
  at TEXT NOT NULL,
  from_id TEXT,
  from_sealed TEXT NOT NULL,
  mine INTEGER NOT NULL,
  mentions_me INTEGER NOT NULL DEFAULT 0,
  text_sealed TEXT NOT NULL,
  -- Reactions as emoji with counts and whether one is mine (JSON); who reacted isn't kept.
  reactions TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (chat_id, id)
);
CREATE INDEX teams_message_at ON teams_message (at);
-- What the crawler found: proposed on My list until I add or dismiss it.
CREATE TABLE teams_finding (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  message_id TEXT,
  kind TEXT NOT NULL,
  title_sealed TEXT NOT NULL,
  due TEXT,
  state TEXT NOT NULL DEFAULT 'new',
  todo_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX teams_finding_state ON teams_finding (state, created_at);
-- Each crawl: up to when messages were looked at, and how it went.
CREATE TABLE teams_crawl (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  upto TEXT NOT NULL,
  messages INTEGER NOT NULL,
  found INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  error TEXT
);
