import rawProductionPolicy from "../config/rate-limit/production.json";

/** Fixed v2 comparison baseline used only while observing the versioned policy. */
export const GRAPHQL_BROWSER_INGRESS_RATE_LIMIT_DEFAULT =
	rawProductionPolicy.legacyV2.browserIngress;
export const GRAPHQL_AUTHENTICATED_RATE_LIMIT_DEFAULT =
	rawProductionPolicy.legacyV2.authenticatedWeighted;
export const GRAPHQL_ANONYMOUS_RATE_LIMIT_DEFAULT = rawProductionPolicy.legacyV2.anonymousWeighted;
