-- Page speed (#294): page loads an hour at a time, by side (server: the app's time; page: the
-- browser's, click to load) and route (the pattern it matched, never a URL), with their total ms
-- and how many fell under 100, 250, 500, 1000, 2000 and 4000 ms (b0–b5) or past it (b6). Kept a
-- week (src/speed.ts).
CREATE TABLE IF NOT EXISTS page_speed (
  hour INTEGER NOT NULL,
  side TEXT NOT NULL,
  route TEXT NOT NULL,
  n INTEGER NOT NULL,
  ms INTEGER NOT NULL,
  b0 INTEGER NOT NULL DEFAULT 0,
  b1 INTEGER NOT NULL DEFAULT 0,
  b2 INTEGER NOT NULL DEFAULT 0,
  b3 INTEGER NOT NULL DEFAULT 0,
  b4 INTEGER NOT NULL DEFAULT 0,
  b5 INTEGER NOT NULL DEFAULT 0,
  b6 INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, side, route)
);
