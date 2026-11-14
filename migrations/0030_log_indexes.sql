-- Two reads that walked their whole table as it grew (#541):
-- the newest writes of one kind (src/actions/deploys.ts, `actionsOf`),
CREATE INDEX IF NOT EXISTS actions_kind ON actions (kind, id);
-- and the last 30 days' agent reviews (src/packs/core/reviews/store.ts), which the (pr, started_at)
-- index can't answer. The daily prune (src/prune.ts) reads by started_at too.
CREATE INDEX IF NOT EXISTS agent_reviews_started ON agent_reviews (started_at);
