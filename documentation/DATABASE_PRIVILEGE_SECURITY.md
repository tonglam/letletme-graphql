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

`DATABASE_STATEMENT_TIMEOUT_MS` defaults to 12,000 ms. Each GraphQL request
has one absolute 12,000 ms execution budget, starting at HTTP ingress. Mini
session validation, season loading, authorization, connection queuing and
serial SQL all consume this budget. The SQL limit is the lesser of its configured
ceiling and the remaining request time. Final response validation rejects expired
fallback/default results with safe `503 / DEPENDENCY_UNAVAILABLE` while headers
can still be sent. Cleanup has at most one further second; 13 seconds is a runtime
target, subject to event-loop scheduling, below the Web upstream's 15 seconds.
Streaming responses retain cancellation ownership until the body ends or cancels.
Health SQL has an independent 2,000 ms budget.

The transport uses Postgres.js 3.4.9's public query cancellation API. The locked
Bun dependency patch returns the cancellation Promise so network failures on the
CancelRequest connection can be observed. The `pg` public text parsers preserve
existing result types, including dates, numeric values and arrays. Each pool slot
owns one `max: 1` driver, which permits public `end({ timeout: 0 })` to discard only
that connection after cancellation, failed rollback or uncertain driver state.
Only confirmed commit or rollback permits reuse. No query is retried on expiry.
No role-level timeout setting or business grant change is required.

Discarding a client alone is **not proof of PostgreSQL query cancellation**.
The previous `pg` disconnect continued until the transaction's timeout on the
production pooler. The bounded candidate probe now sends CancelRequest and
observes the marked query end separately through `pg_stat_activity`. Deployment
runs this read-only probe in the inactive slot before traffic cutover; failed
active cancellation blocks release. Probe statement limits never exceed 1 second.

`DATABASE_POOL_MAX` accepts integers 1–4 and defaults to 4. The example env's
explicit value 2 is a valid smaller pool; the production setting is checked from
the actual deployment. Pool metrics count allocated connection slots, idle slots
and the FIFO wait queue, not PostgreSQL server backends behind the transaction
pooler. Acquisition remains bounded by 2 seconds and idle slots expire after
30 seconds. Background errors have a controlled category and count; connection
objects, SQL, arguments and identities are not logged. A CancelRequest uses a
short-lived protocol socket, not an additional authenticated business session.

Current-season refresh and public Live Matchday coalescing each own a finite
execution scope. Callers only subscribe: one cancellation leaves other waiters
running; the last waiter leaving cancels the shared work. Later waiters cannot
extend its deadline or join an expired task. Existing season pins and publication
revision/shareability fences remain in force.

Run the unit fail-closed cases with:

```bash
bun test tests/infra/database-contract.test.ts tests/infra/read-model-client.test.ts
```

CI additionally replays the accepted Data commit into a disposable PostgreSQL
15 database and runs `bun run contract:check` as a real read-only login.
