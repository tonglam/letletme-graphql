CREATE SCHEMA IF NOT EXISTS bauth;

CREATE TABLE IF NOT EXISTS bauth.external_identities (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES bauth."user"(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    provider_subject TEXT NOT NULL,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE (provider, provider_subject)
);

CREATE INDEX IF NOT EXISTS idx_bauth_external_identities_user
    ON bauth.external_identities (user_id);

CREATE TABLE IF NOT EXISTS bauth.api_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES bauth."user"(id) ON DELETE CASCADE,
    client_type TEXT NOT NULL,
    provider TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    revoked_at TIMESTAMP WITH TIME ZONE,
    last_active_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bauth_api_sessions_user
    ON bauth.api_sessions (user_id);

CREATE INDEX IF NOT EXISTS idx_bauth_api_sessions_active
    ON bauth.api_sessions (provider, expires_at)
    WHERE revoked_at IS NULL;
