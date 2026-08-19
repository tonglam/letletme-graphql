/** Per-IP request gate. 120/min rejected slow Mini browsing and DevTools retries. */
export const GRAPHQL_BROWSER_INGRESS_RATE_LIMIT_DEFAULT = 480;
/** Logged-in weighted units / 60s. */
export const GRAPHQL_AUTHENTICATED_RATE_LIMIT_DEFAULT = 900;
/**
 * Anonymous weighted units / 60s for signed Mini/web browsers.
 * Market desks used to consume ceil(complexity/10) and exhaust 120 in two pages.
 */
export const GRAPHQL_ANONYMOUS_RATE_LIMIT_DEFAULT = 600;
