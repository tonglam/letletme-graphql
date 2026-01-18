# Database Migrations

## How to Run Migrations

### Option 1: Supabase SQL Editor (Recommended)

1. Go to your Supabase project dashboard
2. Navigate to **SQL Editor**
3. Create a new query
4. Copy the contents of `001_auth_schema.sql`
5. Paste and run the SQL

### Option 2: psql Command Line

```bash
# Using the DATABASE_URL from your .env file
psql "postgresql://postgres.gtwcfjoviibmtkevurjw:letletguanlaoshiPg@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true" -f migrations/001_auth_schema.sql
```

### Option 3: Bun Script

```bash
# Run migration using Bun
bun run migrate
```

(Note: You'll need to create a migration script in package.json)

---

## Migration Files

### 001_auth_schema.sql

Creates the authentication tables required for Better Auth and device authentication:

**Better Auth Standard Tables:**
- `user` - User accounts (email, OAuth, anonymous)
- `session` - Web sessions (cookie-based)
- `account` - OAuth accounts and password storage
- `verification` - Email verification codes

**Custom Tables:**
- `device_sessions` - Mobile device sessions (device-based auth)

**Indexes:**
- Performance indexes for all tables
- Foreign key indexes for joins

### 002_auth_rls_policies.sql

Applies Row Level Security (RLS) policies to authentication tables:

**Security Features:**
- Enables RLS on all 5 auth tables
- Users can only view/update their own data
- Users can delete their own sessions/devices
- Service role bypasses all policies (for GraphQL API)

**Policies Applied:**
- `user`: 2 policies (view own, update own)
- `session`: 2 policies (view own, delete own)
- `account`: 1 policy (view own)
- `verification`: 0 policies (backend only)
- `device_sessions`: 2 policies (view own, delete own)

**Total**: 7 RLS policies

---

## Verification

After running the migration, verify the tables were created:

```sql
-- List all auth tables
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name IN ('user', 'session', 'account', 'verification', 'device_sessions');

-- Check user table structure
\d "user"

-- Check device_sessions table structure
\d device_sessions
```

Expected output: 5 tables should be listed.

---

## Rollback (if needed)

To rollback this migration:

```sql
-- Drop tables in reverse order (respecting foreign keys)
DROP TABLE IF EXISTS device_sessions CASCADE;
DROP TABLE IF EXISTS verification CASCADE;
DROP TABLE IF EXISTS account CASCADE;
DROP TABLE IF EXISTS session CASCADE;
DROP TABLE IF EXISTS "user" CASCADE;
```

**⚠️ WARNING**: This will delete all authentication data!

---

## Next Steps

After running the migration:

1. ✅ Start the server: `bun run dev`
2. ✅ Test device authentication: `POST /api/device/auth`
3. ✅ Test GraphQL `me` query
4. ✅ (Optional) Set up OAuth credentials for Google/Apple

---

## Troubleshooting

### Error: relation "user" already exists

The migration is idempotent and uses `IF NOT EXISTS`. If you see this error, it means the tables are already created. You can safely ignore it or run the rollback script first.

### Error: permission denied

Make sure you're using the service_role key or a user with sufficient permissions to create tables.

### Error: syntax error near "user"

PostgreSQL requires double quotes for reserved keywords. The migration uses `"user"` (with quotes) which is correct.
