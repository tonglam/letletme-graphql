-- Authentication Schema
-- Run this migration in your Supabase SQL editor

-- Better Auth standard tables
CREATE TABLE IF NOT EXISTS "user" (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    "emailVerified" BOOLEAN DEFAULT false,
    name TEXT,
    image TEXT,
    "createdAt" TIMESTAMP DEFAULT NOW(),
    "updatedAt" TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "session" (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    "expiresAt" TIMESTAMP NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "account" (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "expiresAt" TIMESTAMP,
    password TEXT,
    "createdAt" TIMESTAMP DEFAULT NOW(),
    "updatedAt" TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "verification" (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    "expiresAt" TIMESTAMP NOT NULL,
    "createdAt" TIMESTAMP DEFAULT NOW()
);

-- Device authentication tables (custom for mobile app)
CREATE TABLE IF NOT EXISTS device_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL UNIQUE,
    device_name TEXT,
    device_os TEXT,
    token TEXT NOT NULL UNIQUE,
    last_active TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Enhanced user metadata
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "deviceId" TEXT UNIQUE;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "isAnonymous" BOOLEAN DEFAULT false;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "linkedAt" TIMESTAMP;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "oauthProvider" TEXT;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "oauthId" TEXT;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_session_userId ON "session"("userId");
CREATE INDEX IF NOT EXISTS idx_session_expiresAt ON "session"("expiresAt");
CREATE INDEX IF NOT EXISTS idx_account_userId ON "account"("userId");
CREATE INDEX IF NOT EXISTS idx_account_accountId_providerId ON "account"("accountId", "providerId");
CREATE INDEX IF NOT EXISTS idx_verification_identifier ON "verification"(identifier);
CREATE INDEX IF NOT EXISTS idx_device_sessions_device_id ON device_sessions(device_id);
CREATE INDEX IF NOT EXISTS idx_device_sessions_token ON device_sessions(token);
CREATE INDEX IF NOT EXISTS idx_device_sessions_user_id ON device_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_deviceId ON "user"("deviceId");
CREATE INDEX IF NOT EXISTS idx_user_email ON "user"(email);

-- Comments
COMMENT ON TABLE "user" IS 'Users table for Better Auth with device authentication support';
COMMENT ON TABLE "session" IS 'Web sessions for cookie-based authentication';
COMMENT ON TABLE "account" IS 'OAuth accounts and password storage';
COMMENT ON TABLE "verification" IS 'Email verification codes';
COMMENT ON TABLE device_sessions IS 'Mobile device sessions for device-based authentication';
