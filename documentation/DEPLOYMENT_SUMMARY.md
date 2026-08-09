# Deployment summary

This repository is the read-heavy GraphQL runtime. Authentication is owned by
`letletme-web`; FPL domain tables and shared sync caches are owned by
`letletme_data`.

## Current runtime contract

- Bun with Apollo Server 5.5.1, PostgreSQL/Supabase, and Redis.
- `POST /graphql`, `GET /health`, and token-protected `GET /metrics`.
- Website v2 signed envelopes and web Mini Program bearer sessions are valid;
  legacy GraphQL WeChat/device tokens are deadline-gated validation only.
- Readiness is degraded when PostgreSQL, Redis, or `Season:active`
  metadata is unavailable.

## Required rollout order

1. Snapshot schema, duplicate bindings, legacy sessions, Redis key types,
   current season/event, and deployed image; take a restorable backup.
2. Apply the web Drizzle migration and deploy web identity/challenge routes.
3. Deploy GraphQL dual verification and set the 30-day legacy validation
   deadline.
4. Release the Mini Program after the WeChat request-domain allowlist is
   configured.
5. Observe scoring shadow metrics, cache fallback metrics, and smoke tests.
6. Retire legacy token validation only after the deadline and seven consecutive
   zero-use days.

## Verification commands

```bash
bun run format:check
bun run lint
bunx tsc --noEmit
bun test
bun run migrate:status
docker compose config --quiet
```

See [`docs/ROLLOUT.md`](../docs/ROLLOUT.md) for rollback and post-deploy
smoke-test gates. This document is not evidence that production deployment or
the 30-day retirement gate has completed.
