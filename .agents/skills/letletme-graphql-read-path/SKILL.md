---
name: letletme-graphql-read-path
description: Audit or change LetLetMe GraphQL ingress, authorization, domain resolvers/read models, Data publication or PostgreSQL fallbacks, query cache, schema contracts, and capacity gates. Do not use for producer writes, Web UI-only work, or generic GraphQL questions.
---

# LetLetMe GraphQL Read Path

Work from the actual `letletme-graphql` checkout. Preserve WIP and establish whether the task is GraphQL-local or a consumer/producer contract change before expanding scope.

## Route before reading broadly

- Request flow, ownership, layer boundaries, or readiness: read [ARCHITECTURE_OVERVIEW.md](../../../documentation/ARCHITECTURE_OVERVIEW.md).
- Ingress, user context, Mini session, or field authorization: read [AUTH_STRATEGY.md](../../../documentation/AUTH_STRATEGY.md) and inspect the executable root-field policies.
- Database startup, roles, grants, or Data read models: read [DATABASE_PRIVILEGE_SECURITY.md](../../../documentation/DATABASE_PRIVILEGE_SECURITY.md).
- Schema/domain/root-field work: inspect `src/graphql/domain-manifest.ts` and [GRAPHQL_DOMAIN_MANIFEST.md](../../../documentation/GRAPHQL_DOMAIN_MANIFEST.md); regenerate rather than hand-edit the generated block.
- Deployment, health, slot behavior, or runtime identity: read [DEPLOYMENT_SUMMARY.md](../../../documentation/DEPLOYMENT_SUMMARY.md).
- Rate-limit or capacity work: read the current rate-limit section of [README.md](../../../README.md), the versioned profile, and the matching loader/observation/profile scripts. Do not reuse historical capacity numbers.

Read only the route required for the task, then verify current source. Documentation defines intended contracts but does not prove the current checkout, deployment, or production state.

## Trace the complete read path

Follow the applicable chain:

1. HTTP method/path, body and AST limits, ingress signature, traffic class, and rate-limit admission.
2. Principal/session resolution and root-field authorization.
3. Domain schema and resolver, then service/read-model/repository shaping.
4. Current-season pin and schema-qualified PostgreSQL read, or complete Data publication validation and coherent fallback.
5. Revision-aware query-cache decision and response/error/data-completeness contract.
6. Web or Mini operation, proxy behavior, and rendered result when the report is user-visible.

Keep source, local tests, fixture-backed database/Redis contracts, deployed image, trusted API response, and rendered client evidence separate. A direct unsigned `401`, liveness response, cached result, or local unit pass proves only its own layer.

## Change the boundary safely

- Keep Data writes and migrations in Data and identity/session issuance in Web. Use only existing authenticated Data clients when GraphQL must request producer-owned work.
- Register each root field once with explicit auth and rate-limit policy. Preserve the `infra/http` dependency boundary and keep resolvers thin.
- Fail closed on missing authority, incomplete publications, unauthorized relationships, retired ingress/configuration, and mismatched schema fields. Do not add silent compatibility fallbacks.
- Key query caches by Data revision and normalized arguments, bound every entry by TTL, and never cache secrets or let cache availability alter authorization.
- For query performance, inspect the actual repository SQL and collect `EXPLAIN`/latency/pool evidence before changing timeouts, indexes, cache policy, or capacity limits. GraphQL cannot add the index itself; route Data-owned schema work to Data.
- Expand to a cross-repository change only when the schema, producer contract, proxy, client operation, or release order actually changes. A normal GraphQL-only change needs no Change ID.

## Validate proportionally

Run the narrowest domain/http/infra test first. Add typecheck and lint; add `layers:check` for dependency changes, `docs:check` for schema/root fields, `deprecation:check` for hard cuts, and the fixture-backed contract checks for database/publication/Redis changes. Use the one-off CI build command when build evidence matters; do not invent `bun run build`.

If a local `.env` contains retired configuration names, run source-only checks with `bun --no-env-file` and explicit non-production canonical test variables. Do not weaken or bypass the runtime retired-config rejection.

Schema changes require affected Web and Mini operations to validate against the exact schema head. Rate-limit changes require the full checked-in measurement pipeline and reviewed evidence; smoke durations cannot promote an enforcement profile.

Production inspection is read-only unless the user authorizes mutation or release. An authorized release must use the checked-in immutable blue/green path and verify the exact deployed identity plus a trusted representative consumer request.
