-- Sign in with GitHub keeps the person's GitHub App user token (#523): sealed with GITHUB_TOKEN_SEAL
-- (src/seal.ts), one row per email. Dovre calls GitHub as that person with it, in place of GITHUB_TOKEN.
CREATE TABLE IF NOT EXISTS github_tokens (
  email TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  access_sealed TEXT NOT NULL,
  access_expires_at INTEGER NOT NULL,
  refresh_sealed TEXT NOT NULL,
  refresh_expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok',
  updated_at INTEGER NOT NULL
);
