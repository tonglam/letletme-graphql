-- Drop the UNIQUE constraint, keep a plain index for lookup performance
ALTER TABLE bauth."user" DROP CONSTRAINT IF EXISTS user_openid_key;
CREATE INDEX IF NOT EXISTS idx_bauth_user_openid ON bauth."user" (openid);
