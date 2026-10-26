-- How many clicks each kind of write takes (dovre#104): "once" where I chose one click.
-- A kind that isn't here asks twice, as every write did before.
CREATE TABLE write_clicks (
  kind TEXT PRIMARY KEY,
  clicks TEXT NOT NULL
);
