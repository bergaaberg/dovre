-- Small settings, one JSON value per key (notification policy, …).
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  at TEXT NOT NULL
);
