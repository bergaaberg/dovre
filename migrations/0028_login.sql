-- The built-in login (#522): passkeys, single-use claim links, sign-in challenges, sessions and a
-- count of tries for rate limits. Only hashes of codes and session tokens are kept, never the values.
CREATE TABLE IF NOT EXISTS login_passkeys (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  jwk TEXT NOT NULL,
  alg INTEGER NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS login_claims (
  hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS login_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  kind TEXT NOT NULL,
  claim TEXT,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_sessions (
  hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  passkey TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_tries (
  key TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS login_tries_key ON login_tries (key, at);
