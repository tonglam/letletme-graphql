# Authentication implementation status

This repository is the GraphQL verifier, not the identity provider.

Implemented here:

- Better Auth dependency, initialization, cookie fallback, and `/api/auth/*`
  routing removed.
- `/api/device/auth` returns `410 Gone`; existing device tokens are accepted
  only before `LEGACY_AUTH_VALIDATION_UNTIL`.
- Web-signed v2 envelopes and web-owned Mini Program session hashes resolve to
  a single principal type.
- Verified FPL entry state is required for entry-scoped authorization.
- GraphQL payload, depth, alias, AST, complexity, batch, and Redis rate limits
  are enforced with fail-closed security routes.

The web repository owns `bauth`, the FPL team-name challenge, and Mini Program
session issuance. The data repository owns domain tables, sync-owned Redis
hashes, and transfer synchronization.

Verification commands are listed in the root README. Rollout order, legacy
grace-period metrics, smoke tests, and rollback rules are in
[`docs/ROLLOUT.md`](../docs/ROLLOUT.md).
