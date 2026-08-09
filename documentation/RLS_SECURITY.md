# Database security boundary

`letletme_data` owns Data Platform schemas and grants
`letletme_graphql_reader` schema usage plus relation `SELECT` only.
`letletme-web` owns `bauth` and any required auth-reader grant. GraphQL owns no
database objects or migrations.

The runtime login must be non-superuser, non-createdb, non-createrole, and
non-bypassrls. It must have no `CREATE` privilege in a Data schema and no
`INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, or `TRIGGER` privilege on
any Data-owned relation. Startup checks these invariants and probes every
registered read model with `LIMIT 0`.

Run the unit fail-closed cases with:

```bash
bun test tests/infra/database-contract.test.ts tests/infra/v3-read-client.test.ts
```

CI additionally replays the accepted Data commit into a disposable PostgreSQL
15 database and runs `bun run contract:check` as a real read-only login.
