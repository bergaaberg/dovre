-- Posting an agent's review (WP-A20): when its draft was posted, what it held (counts and the
-- verdict, never the text), and the review's page on GHE when there is one.
ALTER TABLE agent_reviews ADD COLUMN posted_at INTEGER;
ALTER TABLE agent_reviews ADD COLUMN posted TEXT;
ALTER TABLE agent_reviews ADD COLUMN posted_url TEXT;
