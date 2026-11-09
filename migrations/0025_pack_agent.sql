-- A pack's agent turns (#467): where it may run, which repos ('*': all of mine), other packs' tools by MCP name, and a run's caps.
ALTER TABLE pack_ai ADD COLUMN places TEXT NOT NULL DEFAULT '';
ALTER TABLE pack_ai ADD COLUMN repos TEXT NOT NULL DEFAULT '';
ALTER TABLE pack_ai ADD COLUMN tools TEXT NOT NULL DEFAULT '';
ALTER TABLE pack_ai ADD COLUMN run_usd REAL NOT NULL DEFAULT 1;
ALTER TABLE pack_ai ADD COLUMN turns INTEGER NOT NULL DEFAULT 30;
-- An agent turn beside the text calls: its run, how it stands, where it ran and in which repo. Never the prompt or the output.
ALTER TABLE pack_ai_calls ADD COLUMN kind TEXT NOT NULL DEFAULT 'text';
ALTER TABLE pack_ai_calls ADD COLUMN run TEXT;
ALTER TABLE pack_ai_calls ADD COLUMN state TEXT;
ALTER TABLE pack_ai_calls ADD COLUMN place TEXT;
ALTER TABLE pack_ai_calls ADD COLUMN repo TEXT;
CREATE INDEX pack_ai_calls_run ON pack_ai_calls (run);
