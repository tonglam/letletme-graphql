# Database security boundary

`letletme_data` owns Data Platform schemas and grants
`letletme_graphql_reader` schema usage plus relation `SELECT` only.
`letletme-web` owns `bauth` and any required auth-reader grant. GraphQL owns no
database objects or migrations. The GraphQL reader grant on `bauth."user"` is
exactly `id`, `fpl_entry_id`, and `fpl_entry_verified_at`. The grant on
`bauth.mini_program_session` is exactly `user_id`, `account_id`, `token_hash`,
`revoked_at`, and `expires_at`. The grant on `bauth.mini_program_account` is
exactly `id`, `linked_web_user_id`, `follow_entry_id`, `entry_choice`,
`entry_choice_mini_entry_id`, and `entry_choice_web_entry_id`. Startup rejects
any broader or narrower auth-column set. `src/infra/database-contract.ts` is
the executable authority for these column sets.

The runtime login must be non-superuser, non-createdb, non-createrole, and
non-bypassrls. It must have no `CREATE` privilege in a Data schema and no
`INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, or `TRIGGER` privilege on
any Data-owned relation. Startup checks these invariants and probes every
registered read model with `LIMIT 0`.

## Query execution and transaction pooling

All application SQL uses a checked-out connection and a `BEGIN READ ONLY`
transaction. Before the business query, GraphQL sets `statement_timeout` with
transaction-local `set_config(..., true)`. Connection startup options alone
do not establish the effective timeout on the production transaction pooler.
Verify the setting inside the same transaction as the query; an outside
transaction may still report the pooler's 120-second default.

`DATABASE_STATEMENT_TIMEOUT_MS` defaults to 12,000 ms. The execution budget
includes acquiring the connection, beginning the transaction, SQL and commit.
SQL receives the remaining budget, not a new full allowance after checkout.
Health SQL has an independent 2,000 ms budget. A successful commit or rollback
is required before reuse; cancellation or unsafe cleanup discards the client.
No role-level timeout setting or business grant change is required.

Discarding a client is **not proof of PostgreSQL query cancellation**. A
bounded production-path probe on 2026-09-12 found that Supavisor continued the
query until its local 900 ms timeout after the client disconnected. Active
server cancellation and the full HTTP request budget remain a release gate;
this transaction timeout is a server-side backstop, not that cancellation.

`DATABASE_POOL_MAX` accepts integers 1–4 and defaults to 4. The example env's
explicit value 2 is a valid smaller pool; it is not the production ceiling.
Background idle-client errors are classified and counted without logging
connection details. The pool removes the failed idle client and remains usable.

Run the unit fail-closed cases with:

```bash
bun test tests/infra/database-contract.test.ts tests/infra/read-model-client.test.ts
```

CI additionally replays the accepted Data commit into a disposable PostgreSQL
15 database and runs `bun run contract:check` as a real read-only login.
