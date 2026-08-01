# GraphQL migrations

Only SQL in `forward/` is applied by `bun run migrate`. Files are immutable once
applied: the runner records a SHA-256 checksum, applies each migration in a
transaction, and serializes runners with a PostgreSQL advisory lock. It also
fails when an applied file is missing or when a newly added file sorts before
the applied journal tail.

Historical SQL lives in `legacy/` for audit and disaster recovery. It predates
the checksum ledger and must never be replayed into a fresh database.

Bootstrap ownership is deliberately split:

- `letletme_data` creates and migrates FPL domain tables and sync-owned caches.
- `letletme-web` is the only owner of the `bauth` schema and its Drizzle ledger.
- `letletme-graphql` applies only forward read-model, index, privilege, and RLS
  additions from `migrations/forward`.

The forward journal also owns the four read-only PostgreSQL RPCs called by the
GraphQL repositories. They run as the caller and grant execution only to the
Supabase `service_role`; browser `anon` and `authenticated` roles cannot invoke
them.

Commands:

```bash
bun run migrate
bun run migrate:status
```

Before every production schema or drop migration, take and test a restorable
database backup. Never edit an applied forward migration; add a new one.
