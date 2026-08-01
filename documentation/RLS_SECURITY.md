# Database security boundary

`letletme-web` owns the `bauth` schema, its Better Auth tables, FPL binding
challenge table, and related RLS/migrations. GraphQL must not replay or mutate
those migrations.

The GraphQL repository owns only read-model additions. The forward migration
enables RLS on `public.tournament_selection_stats`, revokes `anon` and
`authenticated` table privileges where those roles exist, and adds the lookup
indexes used by tournament selection statistics. The GraphQL service connects
through its server-side database role and applies authorization before reading
membership-scoped fields.

Verify this contract with the optional PostgreSQL integration test after
bootstrapping domain tables:

```bash
RUN_MIGRATION_INTEGRATION=true bun test tests/migrations/security.integration.test.ts
```

Do not grant browser-facing roles direct access to read-model tables. Changes
to web-owned authentication privileges belong in the web repository.
