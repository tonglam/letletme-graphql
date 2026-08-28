import type { GraphQLIngress } from "../infra/ingress-context";
import type { Principal } from "../infra/principal";
import type { GraphQLRateLimitPolicyV3, TokenBucketPolicy } from "./rate-limit-policy-v3";
import {
	tokenBucketKeyV3,
	type GraphQLRateLimitHeaderScope,
	type TokenBucketCheckV3,
} from "./token-bucket-v3";

const GLOBAL_SUBJECT = "all-graphql-traffic";
const RSC_CLASS_SUBJECT = "all-web-rsc";
const SERVICE_CLASS_SUBJECT = "all-services";

export const graphQLPrincipalSubject = (principal: Principal): string =>
	`principal:${principal.source}:${principal.userId}`;

const requiredSubject = (ingress: GraphQLIngress): string =>
	ingress.subject ?? `missing:${ingress.trafficClass}`;

const check = ({
	id,
	scope,
	subject,
	policy,
	cost = 1,
}: {
	id: string;
	scope: GraphQLRateLimitHeaderScope;
	subject: string;
	policy: TokenBucketPolicy;
	cost?: number;
}): TokenBucketCheckV3 => ({
	id,
	scope,
	key: tokenBucketKeyV3(id, subject),
	refillPerSecond: policy.refillPerSecond,
	burst: policy.burst,
	cost,
});

const globalRequestCheck = (policy: GraphQLRateLimitPolicyV3): TokenBucketCheckV3 =>
	check({
		id: "global-request",
		scope: "global",
		subject: GLOBAL_SUBJECT,
		policy: policy.global,
	});

export const graphQLV3PreAuthRateLimitChecks = (
	ingress: GraphQLIngress,
	policy: GraphQLRateLimitPolicyV3
): readonly TokenBucketCheckV3[] => {
	if (ingress.trafficClass !== "mini") return [];
	// The IP bucket is strictly an ingress abuse guard. Charging it before
	// session validation bounds invalid-token database work, while leaving the
	// global and weighted buckets together in the later atomic stage.
	return [
		check({
			id: ingress.abuseSubject ? "mini-ip-abuse-request" : "mini-ingress-request",
			scope: "client",
			subject: ingress.abuseSubject ?? requiredSubject(ingress),
			policy: policy.trafficClasses.mini.abuseRequest,
		}),
	];
};

/**
 * Trusted requests rejected before cost/principal resolution still pass the
 * global emergency valve exactly once. Valid requests use the full atomic
 * stage below instead, so a denied client/workload never drains global.
 */
export const graphQLV3EarlyFailureRateLimitChecks = (
	policy: GraphQLRateLimitPolicyV3
): readonly TokenBucketCheckV3[] => [globalRequestCheck(policy)];

export type GraphQLV3PrincipalAdmission = {
	readonly audience: "authenticated" | "anonymous" | "workload" | "service";
	readonly checks: readonly TokenBucketCheckV3[];
};

export const graphQLV3PrincipalAdmission = ({
	ingress,
	principal,
	cost,
	policy,
}: {
	ingress: GraphQLIngress;
	principal: Principal | null;
	cost: number;
	policy: GraphQLRateLimitPolicyV3;
}): GraphQLV3PrincipalAdmission => {
	const boundedCost = Math.max(1, Math.floor(cost));
	const globalRequest = globalRequestCheck(policy);
	switch (ingress.trafficClass) {
		case "mini": {
			const authenticated = principal !== null;
			return {
				audience: authenticated ? "authenticated" : "anonymous",
				checks: [
					globalRequest,
					check({
						id: authenticated ? "mini-session-weighted" : "mini-device-weighted",
						scope: "client",
						subject: authenticated ? graphQLPrincipalSubject(principal) : requiredSubject(ingress),
						policy: authenticated
							? policy.trafficClasses.mini.sessionWeighted
							: policy.trafficClasses.mini.anonymousWeighted,
						cost: boundedCost,
					}),
				],
			};
		}
		case "web_browser": {
			const authenticated = principal !== null;
			return {
				audience: authenticated ? "authenticated" : "anonymous",
				checks: [
					globalRequest,
					check({
						id: authenticated ? "web-browser-session-weighted" : "web-browser-anonymous-weighted",
						scope: "client",
						subject: authenticated ? graphQLPrincipalSubject(principal) : requiredSubject(ingress),
						policy: authenticated
							? policy.trafficClasses.web_browser.sessionWeighted
							: policy.trafficClasses.web_browser.anonymousWeighted,
						cost: boundedCost,
					}),
				],
			};
		}
		case "web_rsc":
			return {
				audience: "workload",
				checks: [
					globalRequest,
					check({
						id: "web-rsc-class-request",
						scope: "workload",
						subject: RSC_CLASS_SUBJECT,
						policy: policy.trafficClasses.web_rsc.classRequest,
					}),
					check({
						id: `web-rsc-${ingress.workload}-weighted`,
						scope: "workload",
						subject: `web-rsc:${ingress.workload}`,
						policy: policy.trafficClasses.web_rsc.workloads[ingress.workload],
						cost: boundedCost,
					}),
				],
			};
		case "service":
			return {
				audience: "service",
				checks: [
					globalRequest,
					check({
						id: "service-class-request",
						scope: "workload",
						subject: SERVICE_CLASS_SUBJECT,
						policy: policy.trafficClasses.service.classRequest,
					}),
					check({
						id: "service-weighted",
						scope: "workload",
						subject: requiredSubject(ingress),
						policy: policy.trafficClasses.service.weighted,
						cost: boundedCost,
					}),
				],
			};
		default:
			throw new Error("Untrusted ingress cannot enter rate-limit admission");
	}
};
