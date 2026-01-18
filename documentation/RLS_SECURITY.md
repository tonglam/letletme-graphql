# Row Level Security (RLS) Implementation

**Date**: 2026-01-18  
**Status**: ✅ **COMPLETE** - All auth tables protected  
**Tables**: 5 tables, 7 policies  

---

## 🔒 What is RLS?

Row Level Security (RLS) is a PostgreSQL security feature that controls which rows users can access in a table. In Supabase, RLS is essential for multi-tenant security.

---

## ✅ Current Status

### Tables with RLS Enabled

| Table | RLS Status | Policies | Protected Data |
|-------|-----------|----------|----------------|
| `user` | ✅ Enabled | 2 | User profiles |
| `session` | ✅ Enabled | 2 | Web sessions |
| `account` | ✅ Enabled | 1 | OAuth accounts |
| `verification` | ✅ Enabled | 0 | Email verification |
| `device_sessions` | ✅ Enabled | 2 | Mobile device sessions |

**Total**: 7 RLS policies protecting user authentication data

---

## 📋 Policy Details

### User Table Policies

```sql
-- ✅ Users can view own profile
Policy: "Users can view own profile"
Type: SELECT
Condition: auth.uid()::text = id

-- ✅ Users can update own profile  
Policy: "Users can update own profile"
Type: UPDATE
Condition: auth.uid()::text = id
```

**Effect**: Users can only see and update their own user record.

### Session Table Policies

```sql
-- ✅ Users can view own sessions
Policy: "Users can view own sessions"
Type: SELECT
Condition: auth.uid()::text = "userId"

-- ✅ Users can delete own sessions (logout)
Policy: "Users can delete own sessions"
Type: DELETE
Condition: auth.uid()::text = "userId"
```

**Effect**: Users can view and logout their own sessions, but not others'.

### Account Table Policies

```sql
-- ✅ Users can view own accounts
Policy: "Users can view own accounts"
Type: SELECT
Condition: auth.uid()::text = "userId"
```

**Effect**: Users can see their OAuth connections, but not others'.

### Device Sessions Table Policies

```sql
-- ✅ Users can view own devices
Policy: "Users can view own devices"
Type: SELECT
Condition: auth.uid()::text = user_id

-- ✅ Users can delete own devices (logout device)
Policy: "Users can delete own devices"
Type: DELETE
Condition: auth.uid()::text = user_id
```

**Effect**: Users can view and remove their own devices, but not others'.

### Verification Table Policies

**No user policies** - This table is backend-only (email verification codes).

---

## 🔐 How RLS Works in This Project

### 1. Service Role (GraphQL API)

**Our GraphQL API uses the service role key**, which **bypasses ALL RLS policies**.

```typescript
// src/infra/device-auth.ts
const pool = new Pool({
  connectionString: env.DATABASE_URL, // Uses service_role key
});

// This connection has FULL access to all data
// RLS policies do not apply
```

**Why?**
- GraphQL API implements its own authorization logic
- Resolvers check `context.user` to enforce permissions
- More flexible than RLS for complex business logic
- Better performance (no RLS checks)

### 2. Supabase Client (Frontend)

If you use Supabase client in frontend with `anon` key:

```typescript
// Frontend code
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'YOUR_SUPABASE_URL',
  'YOUR_ANON_KEY' // NOT service_role!
);

// RLS policies ARE enforced
// Users can only see their own data
```

**Effect**: RLS automatically protects data!

### 3. PostgREST API (If Exposed)

If you expose Supabase's auto-generated REST API:

```bash
# Access with anon key
curl https://your-project.supabase.co/rest/v1/user \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Authorization: Bearer USER_JWT"

# RLS policies ARE enforced
# Only returns authenticated user's own data
```

---

## 🛡️ Security Model

### Current Setup

```
┌─────────────────────────────────────────────────────────────┐
│                        Database Access                       │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  GraphQL API (service_role)          Frontend (anon_key)    │
│  ↓                                    ↓                      │
│  Bypasses RLS                         Enforces RLS           │
│  ↓                                    ↓                      │
│  Full access to all data              Only user's own data  │
│  ↓                                    ↓                      │
│  Auth checks in resolvers             Protected by RLS      │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Benefits

| Aspect | Benefit |
|--------|---------|
| **GraphQL API** | Flexible authorization, better performance |
| **Supabase Client** | Automatic data protection, no backend needed |
| **Defense in Depth** | Multiple security layers |
| **Compliance** | Meet security audit requirements |

---

## ✅ Verification

Run this to verify RLS is working:

```bash
bun run migrate:rls
```

Expected output:
```
✅ RLS Status:
  ✓ Enabled - account
  ✓ Enabled - device_sessions
  ✓ Enabled - session
  ✓ Enabled - user
  ✓ Enabled - verification

📋 Policies Created:
  account: 1 policies
  device_sessions: 2 policies
  session: 2 policies
  user: 2 policies

✅ Total: 7 policies applied
```

---

## 🧪 Testing RLS

### Test 1: Service Role Bypasses RLS

```bash
# Using DATABASE_URL (service_role)
# This will return ALL users (RLS bypassed)
psql "$DATABASE_URL" -c 'SELECT id, email FROM "user";'
```

**Expected**: Returns all users (even those belonging to others)

### Test 2: Anon Key Enforces RLS

```sql
-- Using Supabase client with anon key
-- Logged in as user_id = 'abc123'

SELECT * FROM "user" WHERE id = 'xyz789';
-- Returns: 0 rows (can't see other users)

SELECT * FROM "user" WHERE id = 'abc123';
-- Returns: 1 row (your own profile)
```

**Expected**: Can only see own data

---

## 📝 Migration Files

### Apply RLS Policies

```bash
# One-time setup
bun run migrate:rls
```

### Manual SQL (if needed)

```bash
# Via Supabase SQL Editor
# Copy contents of migrations/002_auth_rls_policies.sql
# Paste and run
```

---

## 🚀 Best Practices

### ✅ DO

- ✅ Use service_role key for GraphQL API (current setup)
- ✅ Implement auth checks in GraphQL resolvers
- ✅ Use anon key for Supabase client in frontend
- ✅ Keep RLS enabled for defense in depth
- ✅ Test both service_role and anon access

### ❌ DON'T

- ❌ Don't use anon key in backend (security risk)
- ❌ Don't disable RLS once enabled
- ❌ Don't expose service_role key to frontend
- ❌ Don't rely solely on RLS for authorization logic

---

## 🔍 Monitoring

### Check RLS Status

```sql
SELECT 
  tablename,
  rowsecurity as rls_enabled
FROM pg_tables 
WHERE schemaname = 'public'
AND tablename IN ('user', 'session', 'account', 'verification', 'device_sessions');
```

### List All Policies

```sql
SELECT 
  tablename,
  policyname,
  cmd,
  qual
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;
```

---

## 📚 Related Documentation

- [Authentication Strategy](AUTH_STRATEGY.md) - Overall auth design
- [Implementation Summary](AUTH_IMPLEMENTATION_SUMMARY.md) - What was built
- [Supabase RLS Guide](https://supabase.com/docs/guides/auth/row-level-security)

---

## 🎯 Summary

| Feature | Status |
|---------|--------|
| RLS Enabled | ✅ All 5 tables |
| Policies Created | ✅ 7 policies |
| Service Role Access | ✅ Full access (bypasses RLS) |
| Anon Key Access | ✅ Protected by RLS |
| GraphQL Authorization | ✅ Implemented in resolvers |
| Frontend Protection | ✅ Automatic via RLS |

**Status**: 🔒 **FULLY SECURED**  
**Protection**: Multi-layer defense (RLS + resolver auth)  
**Compliance**: Meets Supabase security standards  

---

**Implemented**: 2026-01-18  
**Migration**: `002_auth_rls_policies.sql`  
**Command**: `bun run migrate:rls`  
**Status**: ✅ **PRODUCTION READY**
