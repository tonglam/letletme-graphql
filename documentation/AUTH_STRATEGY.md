# Authentication contract

Authentication is owned by `letletme-web`. GraphQL does not initialize Better
Auth, serve `/api/auth/*`, issue device sessions, or accept cookie sessions.

## Accepted request credentials

1. Every browser or Mini Program request arrives through a valid, short-lived
   Web-signed ingress context.
2. Website users additionally carry `X-User-Context` and
   `X-User-Context-Sig`. The exact base64url envelope contains `aud`, `uid`,
   `eid`, `evat`, `iat`, and `exp` and expires within 60 seconds. An FPL entry
   is trusted only when `evat` is non-null.
3. Mini Program requests carry a Web-issued bearer token. GraphQL hashes the
   token and validates it against `bauth.mini_program_session` only after the
   ingress signature succeeds. The joined `bauth."user"` read loads only the
   legacy `fpl_entry_id` and `fpl_entry_verified_at` binding fields.
4. Public server-rendered Web reads use the independent GraphQL service token.

Protected entry-scoped fields require a verified entry binding. The public
`entry` lookup and `calcLivePointsByEntry` live calculation are deliberate
exceptions used by public comparison/live-score pages; they do not establish
identity or grant access to history, transfers, leagues, My FPL, or tournament
data. The `fpl_entry_id` column alone is not sufficient for protected fields;
the Web-signed `fpl_entry_verified_at` value is required.

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

`me`, public `entry`, and public live calculation remain available behind the
trusted ingress where documented by the schema. History, transfers, league,
My FPL, and tournament fields are authorized against the resolved principal.
Removed fields include `myDevices`, `revokeDevice`,
`identifyWechatUser`, and `bindFplEntry`.

See [README](../README.md) and the Web repository's authentication contract for
deployment details.
