# Authentication rollout checklist

## Web (`letletme-web`)

- [x] Better Auth and CLI are pinned to 1.6.23 in `letletme-web`.
- [x] Define the `fpl_entry_verified_at` and binding-challenge migration.
- [x] Require existing FPL bindings to be re-verified through the team-name
      challenge before entry-scoped access.
- [x] Verify the partial unique index and concurrent-claim behavior in web
      unit tests.
- [x] Issue Mini Program sessions from web routes only.
- [ ] Add `www.letletme.top` to the Mini Program request-domain allowlist before
      the client release.

## GraphQL (`letletme-graphql`)

- [x] Verify v2 website envelopes and web Mini Program bearer sessions.
- [x] Require verified entry state for protected operations.
- [x] Keep legacy validation behind an explicit deadline and record token-family
      metrics.
- [x] Retire GraphQL auth and device-management mutations.
- [x] Enforce request-size, GraphQL complexity, and Redis rate limits.

## Retirement gate

- [ ] Disable legacy WeChat issuance after the accepted Mini Program release.
- [ ] Keep validation for 30 days after dual verification is deployed.
- [ ] Require seven consecutive days with zero legacy-token use.
- [ ] Back up, then drop only GraphQL-owned legacy tables.
- [ ] Confirm old tokens return 401 while web/Mini Program tokens remain valid.

Do not treat this checklist as evidence of a production deployment. Record
database backups, migration status, metrics, and smoke-test output with each
release.
