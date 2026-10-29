-- An agent's check of my own review before I post it (dovre#299 phase 3): the cards it returned
-- (rewrites, nits, contradictions, missed issues) as JSON, and when. Kept on the review, so they
-- go when it's posted or discarded. Never posted anywhere (src/reviews/check.ts).
ALTER TABLE my_reviews ADD COLUMN check_cards TEXT;
