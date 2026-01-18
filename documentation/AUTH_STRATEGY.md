# Authentication Strategy - Hybrid Approach

**Project**: Fantasy Football GraphQL API  
**Date**: 2026-01-18  
**Status**: Design Complete, Ready for Implementation  

---

## 🎯 Overview

Hybrid authentication system supporting:
- **Website**: OAuth (Google, Apple) + Email/Password
- **Mobile App**: Device-based auto-login (frictionless)
- **Unified Backend**: Single GraphQL API with Better Auth

---

## 🏗️ Architecture

### High-Level Flow

```
┌─────────────┐                    ┌─────────────┐
│   Website   │                    │ Mobile App  │
│             │                    │             │
│ OAuth Login │                    │ Auto-Login  │
│ Email/Pass  │                    │ (Device ID) │
└──────┬──────┘                    └──────┬──────┘
       │                                  │
       │         ┌────────────────┐       │
       └────────►│  Better Auth   │◄──────┘
                 │  /api/auth/*   │
                 └────────┬───────┘
                          │
                 ┌────────▼───────┐
                 │  GraphQL API   │
                 │  /graphql      │
                 └────────┬───────┘
                          │
                 ┌────────▼───────┐
                 │   PostgreSQL   │
                 │  (Supabase)    │
                 └────────────────┘
```

---

## 📊 Database Schema

### Tables

```sql
-- Enhanced user table
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE, -- NULL for anonymous users
    name TEXT,
    emailVerified BOOLEAN DEFAULT false,
    image TEXT,
    
    -- Device authentication (mobile)
    device_id TEXT UNIQUE,
    is_anonymous BOOLEAN DEFAULT false,
    linked_at TIMESTAMP,
    
    -- OAuth (web)
    oauth_provider TEXT, -- 'google', 'apple'
    oauth_id TEXT,
    
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Device sessions (mobile)
CREATE TABLE device_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL UNIQUE,
    device_name TEXT,
    device_os TEXT,
    token TEXT NOT NULL UNIQUE,
    last_active TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Better Auth standard tables (auto-created)
CREATE TABLE session (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL REFERENCES users(id),
    expiresAt TIMESTAMP NOT NULL,
    ipAddress TEXT,
    userAgent TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE account (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL REFERENCES users(id),
    accountId TEXT NOT NULL,
    providerId TEXT NOT NULL,
    accessToken TEXT,
    refreshToken TEXT,
    expiresAt TIMESTAMP,
    password TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE verification (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    expiresAt TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);
```

### Indexes

```sql
CREATE INDEX idx_device_sessions_device_id ON device_sessions(device_id);
CREATE INDEX idx_device_sessions_token ON device_sessions(token);
CREATE INDEX idx_users_device_id ON users(device_id);
CREATE INDEX idx_users_email ON users(email);
```

---

## 🌐 Website Authentication

### Supported Methods
- **Google OAuth** - Primary method
- **Apple OAuth** - Secondary method
- **Email/Password** - Fallback method

### Flow
1. User visits website
2. Clicks "Sign in with Google/Apple" or enters email/password
3. Better Auth handles OAuth flow or credential verification
4. Server sets httpOnly session cookie (7-day expiry)
5. All GraphQL requests automatically authenticated via cookie

### Token Storage
- **Type**: HttpOnly Cookie
- **Duration**: 7 days
- **Security**: 
  - XSS-safe (JavaScript cannot access)
  - CSRF-protected (SameSite=Lax)
  - HTTPS-only (Secure flag)

### Endpoints
- `GET /api/auth/sign-in/google` - Google OAuth
- `GET /api/auth/sign-in/apple` - Apple OAuth
- `POST /api/auth/sign-in/email` - Email/password login
- `POST /api/auth/sign-up/email` - Email/password registration
- `POST /api/auth/sign-out` - Logout

---

## 📱 Mobile App Authentication

### Method
**Device-based Auto-Login** - Zero friction

### Flow
1. User opens app (first time)
2. App generates unique device ID
3. App calls `/api/device/auth` with device ID
4. Server creates anonymous user linked to device
5. Server returns long-lived token (1 year)
6. App stores token in encrypted keychain
7. All GraphQL requests use `Authorization: Bearer <token>`

### Subsequent Opens
1. User opens app
2. App reads token from secure storage
3. App immediately makes GraphQL requests
4. **No login screen, instant access**

### Token Storage
- **Type**: Bearer Token
- **Storage**: SecureStore/Keychain (encrypted)
- **Duration**: 1 year
- **Security**:
  - Device-locked (cannot transfer)
  - Encrypted at OS level
  - Automatic token refresh

### Optional: Link to Full Account
Anonymous users can upgrade to full account:
1. User taps "Sign in to sync across devices"
2. OAuth or email/password flow
3. Anonymous user upgraded (keeps all data)
4. Can now access from web/other devices

### Endpoints
- `POST /api/device/auth` - Device authentication
- `POST /api/auth/link/email` - Link anonymous to email
- `POST /api/auth/link/google` - Link anonymous to Google

---

## 🔒 Security Features

### Website (Cookie-Based)

| Feature | Implementation | Protection |
|---------|----------------|------------|
| HttpOnly Cookie | JavaScript cannot access | XSS attacks |
| Secure Flag | HTTPS only | MITM attacks |
| SameSite=Lax | Cross-site restrictions | CSRF attacks |
| 7-day expiry | Auto-logout | Session hijacking |
| Session rotation | New cookie on activity | Token theft |

### Mobile App (Token-Based)

| Feature | Implementation | Protection |
|---------|----------------|------------|
| Secure Storage | OS-level encryption | Local access |
| Device-locked | Tied to device ID | Token transfer |
| HTTPS only | TLS 1.3+ | MITM attacks |
| 1-year expiry | Long but not infinite | Old devices |
| Token rotation | Refresh before expiry | Token theft |

---

## 🔄 Session Management

### Web Sessions
- **Duration**: 7 days
- **Refresh**: Automatic on each request (if > 1 day old)
- **Storage**: PostgreSQL `session` table
- **Logout**: DELETE session + clear cookie

### Mobile Device Sessions
- **Duration**: 1 year
- **Refresh**: Manual (app checks expiry, calls refresh endpoint)
- **Storage**: PostgreSQL `device_sessions` table
- **Logout**: DELETE token from secure storage (optional server-side revocation)

---

## 🎨 User Experience

### Website
```
User visits site
    ↓
Login page shown
    ↓
Choose: Google / Apple / Email
    ↓
OAuth flow or credential entry
    ↓
Redirected to dashboard
    ↓
Cookie set (transparent)
```

### Mobile App
```
User opens app
    ↓
Splash screen (2 seconds)
    ↓
Auto-authentication
    ↓
Main screen immediately
    ↓
No login required!
```

### Optional Account Linking (Mobile)
```
Anonymous user using app
    ↓
Taps "Sync across devices"
    ↓
OAuth or email signup
    ↓
Anonymous data preserved
    ↓
Now can access from web
```

---

## 🛠️ Technology Stack

### Backend
- **Better Auth** - Authentication library
- **PostgreSQL** - User/session storage
- **GraphQL** - Unified API
- **JWT** - Optional (Better Auth uses sessions by default)

### Frontend (Website)
- **Better Auth Client** - React hooks
- **Apollo Client** - GraphQL client
- **Cookies** - Automatic auth

### Frontend (Mobile)
- **expo-secure-store** - Token storage
- **Apollo Client** - GraphQL client
- **Bearer tokens** - Manual auth header

---

## 📈 Scalability Considerations

### Session Storage
- PostgreSQL sessions scale vertically
- Consider Redis for high traffic (Better Auth supports it)
- Device sessions rarely accessed (no hotspot)

### Device ID Generation
- Client-side generation (no server bottleneck)
- Collision risk: negligible (UUID + timestamp + random)

### OAuth Rate Limits
- Google: 10 requests/second (generous)
- Apple: No published limits (very generous)
- Unlikely to hit limits for typical app

---

## 🚀 Migration Path

### Phase 1: Backend Setup
1. Install Better Auth
2. Create database schema
3. Configure OAuth providers (Google, Apple)
4. Implement device authentication endpoints
5. Update GraphQL context to handle both auth types

### Phase 2: Website Integration
1. Add Better Auth client library
2. Create login page with OAuth buttons
3. Configure Apollo Client with credentials
4. Test OAuth flows

### Phase 3: Mobile Integration
1. Add SecureStore library
2. Implement device ID generation
3. Add auto-authentication on app launch
4. Configure Apollo Client with Bearer token
5. Test device authentication

### Phase 4: Optional Features
1. Account linking UI (mobile)
2. Session management UI (view devices, logout)
3. Email verification flow
4. Password reset flow

---

## 🔍 Monitoring & Analytics

### Metrics to Track
- Anonymous vs. full account users (mobile)
- OAuth provider distribution (Google vs. Apple)
- Average session duration (web vs. mobile)
- Account linking conversion rate
- Failed login attempts

### Logging
- All auth attempts (success/failure)
- Device registrations
- Account linking events
- Session expirations
- Token refreshes

---

## ⚠️ Known Limitations

### Mobile Anonymous Users
- **No cross-device sync** until linked
- **Data loss** if app deleted without linking
- **Single device** per anonymous user

### Solutions
- Encourage account linking for valuable users
- Show "Sync to protect your data" prompts
- Auto-link on first web login with matching criteria

### OAuth Dependencies
- Requires Google/Apple developer accounts
- OAuth keys must be kept secure
- Provider downtime affects website login (fallback to email)

---

## 📚 Related Documentation

- [Better Auth Docs](https://www.better-auth.com)
- [Apollo Client Auth](https://www.apollographql.com/docs/react/networking/authentication/)
- [Expo SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/)

---

## 🎯 Success Criteria

### Website
- ✅ Google/Apple OAuth working
- ✅ Email/password working
- ✅ Session persists across page refreshes
- ✅ Logout clears session
- ✅ Protected queries return user data

### Mobile
- ✅ First launch auto-authenticates
- ✅ Subsequent launches instant access
- ✅ Token stored securely
- ✅ GraphQL queries work without login screen
- ✅ Optional linking to full account

### Security
- ✅ No tokens in localStorage (web)
- ✅ HttpOnly cookies (web)
- ✅ Encrypted storage (mobile)
- ✅ HTTPS enforced (production)
- ✅ Session expiry working

---

**Status**: ✅ Design Complete  
**Next Step**: Implementation (see AUTH_IMPLEMENTATION_CHECKLIST.md)  
**Owner**: Backend Team  
**Review Date**: 2026-01-18
