-- Allow miniprogram-only users (no email/name) in bauth.user
ALTER TABLE bauth."user" ALTER COLUMN email DROP NOT NULL;
ALTER TABLE bauth."user" ALTER COLUMN name DROP NOT NULL;

-- Drop the separate wechat tracking table (no longer needed)
DROP TABLE IF EXISTS bauth.wechat_identities;
