# Implementation checklist

This is the current state of the GraphQL repository. Historical design notes
remain useful context but are not deployment evidence.

- [x] Read-only FPL domains and typed GraphQL schema.
- [x] Web-owned authentication verifier and verified-entry authorization.
- [x] Request body, GraphQL complexity, batch, and Redis rate limits.
- [x] Official-total live scoring path with `LIVE_POINTS_V2` shadow mode.
- [x] Previous-event baseline resolution and ordered transfer reads.
- [x] Season-scoped GraphQL caches with sync-owned key write suppression.
- [x] Production season metadata readiness and event metadata fallback.
- [x] Forward-only migration runner with advisory lock, checksum ledger, and
      `migrate:status`.
- [x] CI format/lint/typecheck/test/build/Compose/OSV/Gitleaks gates.
- [ ] Deploy database, web, GraphQL, and Mini Program in the order documented
      in [`docs/ROLLOUT.md`](../docs/ROLLOUT.md).
- [ ] Complete the 30-day legacy-token retirement gate in production.

Run the verification commands in the root README before marking a release.
