# Authentication contract

Authentication is owned by `letletme-web`. GraphQL does not initialize Better
Auth, serve `/api/auth/*`, issue device sessions, or accept cookie sessions.

## Accepted request credentials

1. Website requests carry `X-User-Context` and `X-User-Context-Sig`. The
   signed base64url envelope is version 2, has audience `letletme-graphql`,
   includes `uid`, `iat`, and `exp`, and expires within 60 seconds. An FPL
   entry is included only when `fpl_entry_verified_at` is non-null.
2. Mini Program requests carry a web-issued bearer token. GraphQL hashes the
   token and validates it against `bauth.mini_program_session`.
3. Old GraphQL WeChat and device tokens are validation-only during the explicit
   `LEGACY_AUTH_VALIDATION_UNTIL` grace window. They are never issued by this
   service and are removed after the seven-day zero-use retirement gate.

Every entry-scoped field requires a verified entry binding. The `fpl_entry_id`
column alone is not sufficient; existing bindings are intentionally unverified
until the web team-name challenge is completed. Concurrent verification is
serialized and the web database has a partial unique index on verified entry
IDs.

## Web binding challenge

The web service validates the public FPL entry, invalidates a user's previous
pending challenge, and generates an exact `LLM-XXXXXX` team name. Challenges
expire after 15 minutes, allow at most ten attempts, and are limited to three
creations per user per hour. Confirmation compares trimmed,
case-insensitive team names while locking both the challenge and user rows.

## Mini Program flow

The Mini Program calls `www.letletme.top` for WeChat/email-link account routes,
stores the returned web session token, and sends that token to GraphQL. It does
not submit an FPL entry ID during login; entry access is inherited only from
the verified web account.

## Public GraphQL boundary

`me` and read-only FPL data remain public where documented by the schema.
Entry, league, tournament, and calculation fields are authorized against the
resolved principal. Removed fields include `myDevices`, `revokeDevice`,
`identifyWechatUser`, and `bindFplEntry`.

See [README](../README.md), [rollout contract](../docs/ROLLOUT.md), and the
web repository's Better Auth and binding migration for deployment details.
