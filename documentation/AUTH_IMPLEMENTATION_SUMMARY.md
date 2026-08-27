# Authentication implementation status

This repository is the GraphQL verifier, not the identity provider.

Implemented here:

- Former identity-provider dependency, initialization, cookie fallback, and
  `/api/auth/*` routing are not part of this service.
- `/api/device/auth` is not registered and returns the ordinary `404` response.
- Exact Web-signed envelopes and Web-owned Mini Program session hashes resolve
  to one principal type behind verified ingress.
- Verified FPL entry state is required for protected entry-scoped authorization;
  public `entryLookup` and live calculation remain explicitly documented
  exceptions.
- GraphQL payload, depth, alias, AST, complexity, batch, and Redis rate limits
  are enforced with fail-closed security routes.

The web repository owns `bauth`, the FPL team-name challenge, and Mini Program
session issuance. The data repository owns domain tables, sync-owned Redis
hashes, and transfer synchronization.

Verification commands and the runtime contract are listed in the root README.
