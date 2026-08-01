ALTER TABLE bauth."user" ADD COLUMN IF NOT EXISTS openid TEXT UNIQUE;

CREATE TABLE IF NOT EXISTS bauth.wechat_identities (
    openid       TEXT PRIMARY KEY,
    fpl_entry_id INTEGER,
    linked_at    TIMESTAMP WITH TIME ZONE,
    created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wechat_identities_fpl ON bauth.wechat_identities (fpl_entry_id);
