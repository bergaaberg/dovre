-- A pack's own small state (#476, ctx.store.kv): JSON by key, each pack seeing only its own rows. `expires`: epoch ms, or NULL to keep.
CREATE TABLE pack_kv (
  pack TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  at INTEGER NOT NULL,
  expires INTEGER,
  PRIMARY KEY (pack, key)
);
