-- Stuck auto runs try again on their own (#254): how many times this issue's turn has got stuck
-- since an owner last labelled it. The third stuck closes it out and takes dovre:auto off.
ALTER TABLE auto_runs ADD COLUMN tries INTEGER NOT NULL DEFAULT 0;
