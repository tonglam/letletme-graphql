-- Hash device session tokens at rest (SHA-256 hex), matching bauth.api_sessions.
-- Existing plaintext tokens are invalidated: clients must re-authenticate.

ALTER TABLE device_sessions
  ADD COLUMN IF NOT EXISTS token_hash TEXT;

-- Allow clearing plaintext tokens after hashing.
ALTER TABLE device_sessions ALTER COLUMN token DROP NOT NULL;

-- Drop plaintext uniqueness; keep column temporarily for rollback safety.
ALTER TABLE device_sessions DROP CONSTRAINT IF EXISTS device_sessions_token_key;

UPDATE device_sessions SET token = NULL WHERE token IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_device_sessions_token_hash
  ON device_sessions (token_hash)
  WHERE token_hash IS NOT NULL;

COMMENT ON COLUMN device_sessions.token_hash IS
  'SHA-256 hex digest of the bearer token. Plaintext token is never stored.';
