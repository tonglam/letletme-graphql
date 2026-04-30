ALTER TABLE "user" ADD COLUMN IF NOT EXISTS openid TEXT UNIQUE;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS fpl_entry_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_user_fpl_entry_id ON "user" (fpl_entry_id);
CREATE INDEX IF NOT EXISTS idx_user_openid ON "user" (openid);
