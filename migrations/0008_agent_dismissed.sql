-- Agent sessions started here that I cleared away (src/agents/dismissed.ts): Dovre's lists leave
-- them out. Claude Code's and omp's own files aren't touched; a new turn brings a session back.
CREATE TABLE agent_dismissed (
  session_id TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
