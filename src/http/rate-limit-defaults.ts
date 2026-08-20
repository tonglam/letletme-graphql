import rawProductionPolicy from "../config/rate-limit/production.json";

/** Legacy-v2 defaults remain deploy-tunable for rollback compatibility. */
export const GRAPHQL_BROWSER_INGRESS_RATE_LIMIT_DEFAULT =
	rawProductionPolicy.legacyV2.browserIngress;
export const GRAPHQL_AUTHENTICATED_RATE_LIMIT_DEFAULT =
	rawProductionPolicy.legacyV2.authenticatedWeighted;
export const GRAPHQL_ANONYMOUS_RATE_LIMIT_DEFAULT = rawProductionPolicy.legacyV2.anonymousWeighted;
