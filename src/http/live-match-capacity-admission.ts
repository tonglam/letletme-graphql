import type { GraphQLIngress } from "../infra/ingress-context";
import { hasLiveMatchesV3Contract } from "./live-matches-contract";
import { metricsTokenMatches } from "./runtime-http";

export const LIVE_MATCH_CAPACITY_USER_AGENT_PREFIX = "LetLetMe-LiveMatch-Capacity/";

type MetricsTokenMatcher = (provided: string | undefined) => boolean;

/**
 * In-container live-match capacity probes authenticate with the existing
 * service token plus the metrics token. Public ingress never presents that
 * pair, so the global emergency valve stays in force for Web/Mini traffic.
 */
export const isLiveMatchCapacityAdmission = (
	headers: Headers,
	ingress: GraphQLIngress,
	tokenMatches: MetricsTokenMatcher = metricsTokenMatches
): boolean => {
	if (ingress.class !== "service" || ingress.trafficClass !== "service") return false;
	if (!hasLiveMatchesV3Contract(headers)) return false;
	const userAgent = headers.get("user-agent") ?? "";
	if (!userAgent.startsWith(LIVE_MATCH_CAPACITY_USER_AGENT_PREFIX)) return false;
	return tokenMatches(headers.get("x-metrics-token") ?? undefined);
};
