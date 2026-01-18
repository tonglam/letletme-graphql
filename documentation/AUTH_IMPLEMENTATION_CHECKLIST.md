# Authentication Implementation Checklist

Track progress for implementing hybrid authentication (Better Auth + Device Auth).

---

## Phase 1: Backend Setup 🔧

### Dependencies & Configuration
- [ ] Install Better Auth (`bun add better-auth`)
- [ ] Install pg pool (`bun add pg @types/pg`)
- [ ] Add environment variables:
  - [ ] `JWT_SECRET` (generate secure random key)
  - [ ] `GOOGLE_CLIENT_ID` (from Google Cloud Console)
  - [ ] `GOOGLE_CLIENT_SECRET`
  - [ ] `APPLE_CLIENT_ID` (from Apple Developer)
  - [ ] `APPLE_CLIENT_SECRET`
  - [ ] `APP_URL` (frontend URL for OAuth callbacks)
- [ ] Update `.env.example` with new vars (placeholders only)

### Database Schema
- [ ] Create `users` table (with device_id support)
- [ ] Create `device_sessions` table
- [ ] Run Better Auth schema generation (or create manually)
  - [ ] `session` table
  - [ ] `account` table
  - [ ] `verification` table
- [ ] Create indexes for performance
- [ ] Test database migrations

### Auth Infrastructure
- [ ] Create `src/infra/auth.ts`:
  - [ ] Initialize Better Auth with config
  - [ ] Configure email/password provider
  - [ ] Configure Google OAuth
  - [ ] Configure Apple OAuth
  - [ ] Export auth instance
- [ ] Create `src/infra/device-auth.ts`:
  - [ ] `authenticateDevice()` function
  - [ ] `validateDeviceToken()` function
  - [ ] `generateDeviceToken()` helper
  - [ ] `revokeDeviceToken()` function
- [ ] Update `src/infra/env.ts`:
  - [ ] Add auth-related env vars
  - [ ] Validate required auth vars
- [ ] Update `src/graphql/context.ts`:
  - [ ] Add `user?: AuthUser` to context type
  - [ ] Add `isAnonymous?: boolean` flag

### Server Integration
- [ ] Update `src/index.ts`:
  - [ ] Add Better Auth handler for `/api/auth/*` routes
  - [ ] Add device auth endpoint `/api/device/auth`
  - [ ] Add device link endpoint `/api/device/link`
  - [ ] Add session validation middleware
  - [ ] Update GraphQL context to include user
  - [ ] Handle both cookie and Bearer token auth
- [ ] Add CORS configuration:
  - [ ] Allow credentials for cookies
  - [ ] Whitelist frontend domains
- [ ] Test auth endpoints manually

---

## Phase 2: GraphQL Auth Layer 🔐

### Auth Domain (GraphQL)
- [ ] Create `src/domains/auth/` directory
- [ ] Create `src/domains/auth/schema.ts`:
  - [ ] `User` type
  - [ ] `AuthPayload` type
  - [ ] `me` query (get current user)
  - [ ] Optional: `logout` mutation
- [ ] Create `src/domains/auth/resolvers.ts`:
  - [ ] `me` resolver (returns `context.user`)
  - [ ] Error handling for unauthenticated requests
- [ ] Wire auth schema into main schema
- [ ] Test `me` query with/without auth

### Protected Mutations (Entries Domain)
- [ ] Update `src/domains/entries/schema.ts`:
  - [ ] Add `Mutation` type
  - [ ] Add `makeTransfers` mutation
  - [ ] Add `setCaptain` mutation
  - [ ] Add `playChip` mutation
- [ ] Create `src/domains/entries/mutations.ts`:
  - [ ] Implement transfer logic
  - [ ] Budget validation
  - [ ] Squad limit validation
  - [ ] Captain validation
  - [ ] Chip validation
- [ ] Update `src/domains/entries/resolvers.ts`:
  - [ ] Add mutation resolvers
  - [ ] Add auth guards (`if (!context.user)`)
  - [ ] Add ownership validation
- [ ] Test protected mutations

### Authorization Helpers
- [ ] Create `src/infra/guards.ts`:
  - [ ] `requireAuth()` - Throw if not authenticated
  - [ ] `requireOwnership()` - Verify resource ownership
  - [ ] `requireRole()` - Check user role
- [ ] Add to resolvers for protection

---

## Phase 3: Website Frontend Integration 🌐

### Prerequisites
- [ ] Register Google OAuth app (get client ID/secret)
- [ ] Register Apple OAuth app (get client ID/secret)
- [ ] Configure OAuth redirect URLs

### Better Auth Client Setup
- [ ] Install: `npm install better-auth`
- [ ] Create `lib/auth.ts`:
  - [ ] Initialize Better Auth client
  - [ ] Export auth utilities
  - [ ] Create auth hooks (`useAuth`, `useUser`)
- [ ] Create `lib/apollo.ts`:
  - [ ] Apollo Client with `credentials: 'include'`
  - [ ] No custom auth link needed (cookies automatic)

### UI Components
- [ ] Create login page:
  - [ ] "Sign in with Google" button
  - [ ] "Sign in with Apple" button
  - [ ] Email/password form
  - [ ] Link to registration page
- [ ] Create registration page:
  - [ ] Email/password form
  - [ ] Password strength indicator
  - [ ] Terms acceptance checkbox
- [ ] Create user menu:
  - [ ] Show user name/email
  - [ ] Logout button
  - [ ] Profile link
- [ ] Add protected route guards
- [ ] Add loading states

### Testing
- [ ] Test Google OAuth flow
- [ ] Test Apple OAuth flow
- [ ] Test email/password registration
- [ ] Test email/password login
- [ ] Test logout
- [ ] Test session persistence (refresh page)
- [ ] Test protected GraphQL queries

---

## Phase 4: Mobile App Integration 📱

### Device Authentication Setup
- [ ] Install: `npm install expo-secure-store expo-device`
- [ ] Create `lib/device-auth.ts`:
  - [ ] `getOrCreateDeviceId()` function
  - [ ] `initializeAuth()` function
  - [ ] `getAuthToken()` function
  - [ ] `linkAccount()` function (optional)
- [ ] Create `lib/apollo.ts`:
  - [ ] Apollo Client with auth link
  - [ ] Bearer token from SecureStore
  - [ ] Auto-retry on 401

### App Initialization
- [ ] Update `App.tsx`:
  - [ ] Call `initializeAuth()` on launch
  - [ ] Show splash screen during auth
  - [ ] Navigate to main screen after auth
- [ ] Test first launch (new device)
- [ ] Test subsequent launches (existing token)
- [ ] Test token expiry handling

### Optional: Account Linking UI
- [ ] Create account settings screen
- [ ] Add "Sync across devices" button
- [ ] Create email/password link form
- [ ] Create OAuth link buttons
- [ ] Show account status (anonymous vs. linked)
- [ ] Test linking flow

### Testing
- [ ] Test fresh install (new device ID)
- [ ] Test app restart (token persistence)
- [ ] Test GraphQL queries with device token
- [ ] Test token expiry (manual expiry)
- [ ] Test account linking (optional)
- [ ] Test uninstall/reinstall (new anonymous user)

---

## Phase 5: Advanced Features ⚡

### Session Management
- [ ] Add "Active Sessions" page (web):
  - [ ] List all user sessions
  - [ ] Show IP, device, last active
  - [ ] "Logout all other sessions" button
- [ ] Add session revocation API:
  - [ ] Revoke specific session
  - [ ] Revoke all sessions except current
- [ ] Test session management

### Email Verification
- [ ] Enable email verification in Better Auth
- [ ] Create verification email template
- [ ] Add verification required guard
- [ ] Test email verification flow

### Password Reset
- [ ] Add forgot password endpoint
- [ ] Create password reset email template
- [ ] Add password reset form (web)
- [ ] Test password reset flow

### Rate Limiting
- [ ] Add rate limiter library (`bun add @upstash/ratelimit`)
- [ ] Rate limit auth endpoints:
  - [ ] Login: 5 attempts per 15 minutes
  - [ ] Registration: 3 per hour per IP
  - [ ] Device auth: 10 per hour per device
- [ ] Return 429 Too Many Requests on limit
- [ ] Test rate limiting

### Account Security
- [ ] Add password strength requirements
- [ ] Add password history (prevent reuse)
- [ ] Add login attempt tracking
- [ ] Add suspicious activity detection
- [ ] Add account lockout (after N failed attempts)

---

## Phase 6: Testing & Quality Assurance 🧪

### Unit Tests
- [ ] Auth infrastructure tests:
  - [ ] Device ID generation
  - [ ] Token validation
  - [ ] Session creation/validation
- [ ] Repository tests:
  - [ ] User CRUD operations
  - [ ] Device session CRUD
  - [ ] Account linking logic
- [ ] Resolver tests:
  - [ ] Protected resolvers require auth
  - [ ] Public resolvers work without auth

### Integration Tests
- [ ] End-to-end auth flows:
  - [ ] Web OAuth registration → login → GraphQL
  - [ ] Web email registration → login → GraphQL
  - [ ] Mobile device auth → GraphQL
  - [ ] Mobile account linking → web access
- [ ] Session expiry scenarios
- [ ] Token refresh scenarios

### Security Testing
- [ ] Test XSS protection (httpOnly cookies)
- [ ] Test CSRF protection (SameSite cookies)
- [ ] Test token theft scenarios
- [ ] Test unauthorized access attempts
- [ ] Test SQL injection (parameterized queries)
- [ ] Test password requirements enforcement

---

## Phase 7: Deployment & Monitoring 🚀

### Production Configuration
- [ ] Generate production JWT secret (strong random)
- [ ] Configure production OAuth redirect URLs
- [ ] Set production cookie domain
- [ ] Enable HTTPS enforcement
- [ ] Configure CORS for production domains

### Monitoring
- [ ] Add auth metrics to Prometheus:
  - [ ] Login success/failure rate
  - [ ] OAuth provider distribution
  - [ ] Anonymous vs. full account ratio
  - [ ] Session duration average
  - [ ] Active sessions count
- [ ] Add auth logging:
  - [ ] All login attempts (with IP)
  - [ ] Failed authentications
  - [ ] Account linking events
  - [ ] Suspicious activity

### Documentation
- [ ] Update API documentation with auth examples
- [ ] Create frontend integration guide
- [ ] Document OAuth setup steps
- [ ] Document device auth flow
- [ ] Add troubleshooting guide

---

## 📋 Implementation Order

### Sprint 1: Core Auth (1-2 weeks)
1. Backend setup (database + Better Auth)
2. Device authentication for mobile
3. Basic GraphQL `me` query
4. Test with curl/Postman

### Sprint 2: Website (1 week)
1. OAuth provider registration
2. Frontend Better Auth integration
3. Login/registration pages
4. Test all OAuth flows

### Sprint 3: Mobile (1 week)
1. Device ID generation
2. Auto-login implementation
3. Apollo Client configuration
4. Test device authentication

### Sprint 4: Protected Mutations (1-2 weeks)
1. Transfer validation logic
2. Captain selection
3. Chip activation
4. Authorization guards

### Sprint 5: Polish (1 week)
1. Account linking UI
2. Session management
3. Email verification
4. Password reset
5. Rate limiting

---

## ✅ Success Criteria

### Backend
- [ ] All auth endpoints returning 200 for valid requests
- [ ] Sessions persisting across requests
- [ ] Device tokens working for mobile
- [ ] Protected resolvers blocking unauthenticated users
- [ ] Zero linting errors

### Website
- [ ] Google OAuth working end-to-end
- [ ] Apple OAuth working end-to-end
- [ ] Email/password working
- [ ] Session persists on page refresh
- [ ] Logout clears session
- [ ] Protected queries accessible when logged in

### Mobile
- [ ] First launch auto-authenticates (no login screen)
- [ ] Token persists across app restarts
- [ ] GraphQL queries work immediately
- [ ] Token stored securely (not in AsyncStorage)
- [ ] Optional account linking working

### Security
- [ ] No tokens in browser localStorage
- [ ] HttpOnly cookies on web
- [ ] Encrypted token storage on mobile
- [ ] HTTPS enforced in production
- [ ] Rate limiting active on auth endpoints
- [ ] No sensitive data in logs

---

## 📊 Estimated Effort

| Phase | Tasks | Estimated Time |
|-------|-------|----------------|
| Backend Setup | 15 tasks | 3-5 days |
| GraphQL Auth Layer | 12 tasks | 2-3 days |
| Website Integration | 11 tasks | 3-4 days |
| Mobile Integration | 9 tasks | 2-3 days |
| Advanced Features | 14 tasks | 4-5 days |
| Testing & QA | 15 tasks | 3-4 days |
| Deployment | 11 tasks | 1-2 days |

**Total**: ~87 tasks, ~18-26 days (1 developer)

---

## 🚧 Blockers & Dependencies

### External Dependencies
- **Google OAuth Setup** - Requires Google Cloud Console access
- **Apple OAuth Setup** - Requires Apple Developer account ($99/year)
- **Production Domain** - Needed for OAuth redirect URLs
- **SSL Certificate** - Required for Secure cookies

### Technical Dependencies
- Database migrations must run before auth testing
- Frontend must support cookies (CORS configured)
- Mobile must have SecureStore available (Expo or equivalent)

---

## 📝 Notes

### Why This Approach?
- **Better Auth** gives full control without vendor lock-in
- **Device-based mobile auth** provides frictionless UX
- **Hybrid approach** matches platform conventions:
  - Web: Professional OAuth (users expect this)
  - Mobile: Instant access (users expect this)
- **Future-proof**: Can add providers, 2FA, etc.

### Alternative Approaches Considered
1. **Supabase Auth** - Rejected: You want independence from Supabase
2. **Custom JWT Only** - Rejected: Reinventing the wheel, more work
3. **Auth0/Firebase** - Rejected: Vendor lock-in, costs money
4. **Better Auth** - ✅ Selected: Best balance of control + convenience

---

**Created**: 2026-01-18  
**Status**: Ready for Implementation  
**Priority**: High (required for mutations)  
**Estimated Completion**: 3-4 weeks
