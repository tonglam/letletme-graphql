-- RLS Policies for Authentication Tables
-- Run this migration after 001_auth_schema.sql

/*
  Security Model:
  - Our GraphQL API uses service_role key (bypasses RLS)
  - These policies protect data when accessed via:
    * Supabase client libraries (if used by frontend)
    * PostgREST API (if exposed)
    * Supabase Dashboard
*/

-- ============================================================================
-- Enable RLS on all auth tables
-- ============================================================================

ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "verification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_sessions ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- USER table policies
-- ============================================================================

-- Users can read their own user record
CREATE POLICY "Users can view own profile"
ON "user"
FOR SELECT
USING (auth.uid()::text = id);

-- Users can update their own user record
CREATE POLICY "Users can update own profile"
ON "user"
FOR UPDATE
USING (auth.uid()::text = id)
WITH CHECK (auth.uid()::text = id);

-- ============================================================================
-- SESSION table policies
-- ============================================================================

-- Users can read their own sessions
CREATE POLICY "Users can view own sessions"
ON "session"
FOR SELECT
USING (auth.uid()::text = "userId");

-- Users can delete their own sessions (logout)
CREATE POLICY "Users can delete own sessions"
ON "session"
FOR DELETE
USING (auth.uid()::text = "userId");

-- ============================================================================
-- ACCOUNT table policies
-- ============================================================================

-- Users can read their own accounts (OAuth connections)
CREATE POLICY "Users can view own accounts"
ON "account"
FOR SELECT
USING (auth.uid()::text = "userId");

-- ============================================================================
-- VERIFICATION table policies
-- ============================================================================

-- Verification table has no user policies (managed by backend only)
-- Service role key automatically bypasses RLS

-- ============================================================================
-- DEVICE_SESSIONS table policies
-- ============================================================================

-- Users can read their own device sessions
CREATE POLICY "Users can view own devices"
ON device_sessions
FOR SELECT
USING (auth.uid()::text = user_id);

-- Users can delete their own device sessions (logout device)
CREATE POLICY "Users can delete own devices"
ON device_sessions
FOR DELETE
USING (auth.uid()::text = user_id);

-- ============================================================================
-- Important Notes
-- ============================================================================

/*
  RLS Bypass for Service Role:
  - Our GraphQL API connects with service_role key (DATABASE_URL)
  - Service role automatically bypasses ALL RLS policies
  - This means our API has full access to all tables
  - RLS only applies to connections using anon or authenticated keys

  Frontend Integration:
  - If you use Supabase client in frontend with anon key:
    * Users will only see their own data (protected by RLS)
  - If you use GraphQL API (recommended):
    * All data access is controlled by your GraphQL resolvers
    * RLS is bypassed (service role)
    * You implement authorization in resolvers

  Best Practice:
  - Keep using GraphQL API with service role for backend
  - Implement authorization checks in GraphQL resolvers
  - RLS provides an additional security layer for direct database access
*/
