-- Writes take one click by default now; a row marks a kind I set to ask twice.
-- The old "once" rows mean nothing any more. Where auto runs were set up, an auto run's draft PR
-- keeps waiting for me unless I had already let it open by itself.
INSERT INTO write_clicks (kind, clicks)
  SELECT 'auto.pr', 'twice'
  WHERE EXISTS (SELECT 1 FROM settings WHERE key = 'auto')
    AND NOT EXISTS (SELECT 1 FROM write_clicks WHERE kind = 'auto.pr' AND clicks = 'once');
DELETE FROM write_clicks WHERE clicks = 'once';
