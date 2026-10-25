-- Team channels I follow in Dovre (src/teams/channels.ts). Ids only: names and posts come from
-- Graph and stay in memory. seen_at: the newest post I've seen there (opening its page).
CREATE TABLE teams_follow (
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  seen_at TEXT,
  PRIMARY KEY (team_id, channel_id)
);
