# Coordinated remediation rollout

## Before the first production mutation

1. Run `bun run preflight:snapshot > preflight-YYYYMMDD.json` from a trusted
   operator host and record the current deployed image.
2. Capture a restorable database backup and perform a restore test.
3. Record duplicate FPL bindings, active legacy sessions, Redis key types,
   `Season:active`, `event:current`, and the current image.
4. Confirm `www.letletme.top` is in the WeChat Mini Program request-domain
   allowlist.

Do not commit snapshots or backups; they contain operational metadata.

## Deployment order

1. Provision the same independent `GRAPHQL_SERVICE_TOKEN` in GraphQL and Web.
   Deploy GraphQL with signed-ingress compatibility enabled and
   `REQUIRE_SIGNED_WEB_INGRESS=false`.
2. Apply the web Drizzle migration using `DIRECT_DATABASE_URL`; migration
   aborts on duplicate non-null `openid` values.
3. Deploy web challenge, database rate limiting, and web-issued Mini Program sessions.
4. Confirm cached public RSC queries carry only `X-GraphQL-Service-Token`, and
   authenticated Web traffic carries the signed ingress and user envelopes.
   Then deploy GraphQL with both the Web Mini Program verifier and
   deadline-gated legacy verifier. Set `LEGACY_AUTH_VALIDATION_UNTIL` to
   exactly 30 days after this deployment.
5. Release the Mini Program client against
   `https://www.letletme.top/api/graphql`.
6. Once the Mini Program release is accepted, keep
   `LEGACY_WECHAT_ISSUANCE_ENABLED=false`.
7. Require seven consecutive days where
   `graphql_ingress_requests_total{class=~"unsigned_bearer|anonymous|unsigned_user_context"}`
   has no supported-client traffic before setting
   `REQUIRE_SIGNED_WEB_INGRESS=true`.
8. After the legacy deadline, require seven consecutive days where
   `auth_token_validations_total{family="legacy_graphql_wechat"}` and
   `{family="legacy_device"}` stay at zero before dropping backed-up legacy
   tables.

At the trusted-ingress cutover, apply the reviewed Nginx snippet under
`ops/nginx/graphql-hardening.conf.example`, enable Cloudflare Authenticated
Origin Pulls, and restrict origin ports 80/443 to Cloudflare's published IP
ranges. Keep port 4000 blocked. Do not weaken the origin firewall when rolling
back application behavior.

For Data transfer persistence, first deploy the Data hardening PR with
`TRANSFER_SYNC_MODE=latest`. Apply the stacked transfer migration `0034`, then
set `TRANSFER_SYNC_MODE=all` and trigger the existing `entry-transfers` job. It
reads full FPL history for every known entry and verifies every persisted
signature, so no one-off backfill script is needed. Validate multiple transfers
for one entry/event before deploying GraphQL's canonical history reads. The
pre-cutover Data image is not a rollback target after enabling all-mode.

Web accepts `CF-Connecting-IP` only on the configured production host with the
Cloudflare marker present, and accepts `x-vercel-forwarded-for` only for Vercel
preview hosts with Vercel metadata. It stores and forwards only an HMAC-derived
opaque subject. Generic forwarding headers never select a rate bucket.

The GraphQL schema no longer exposes direct FPL binding, identity discovery, or
device-management fields. Legacy bearer validation is the only grace behavior.

## Live scoring gate

Keep `LIVE_POINTS_V2=false` while comparing
`live_points_shadow_differences_total` on sampled SGW and DGW traffic. Verify a
completed SGW, completed DGW, provisional bonus, captain, triple captain, and
autosub examples before enabling globally. Disable the flag to roll back.
V2 reads Data's additive `LiveBonusV2:{season}:{event}` fixture-summed hash; Redis
errors mean no override, preserving FPL's official aggregate total. The legacy
`LiveBonus` and `PlayerValue` contracts are not mutated by GraphQL.

## Smoke tests

- `/health` is 200 and reports Redis, PostgreSQL, and season metadata healthy.
- A signed website request with a verified entry succeeds; an unverified or
  mismatched entry is denied.
- Web-issued Mini Program login succeeds; a bare device ID cannot issue or
  replace a session.
- Live scores, one DGW fixture, Redis-loss fallback, ordered transfer history,
  and `bun run migrate:status` succeed.
- Old tokens return 401 after the deadline while website and Mini Program
  tokens continue to work.

## Rollback

Every deploy keeps the current and previous two repository images. Roll back by
setting `APP_IMAGE` to one of those reviewed tags and running
`docker compose up -d --no-build`. Feature behavior can be rolled back with
`LIVE_POINTS_V2=false`; never roll back a consumed FPL challenge or applied
forward migration by editing history. Use a new migration or restore the tested
backup.
