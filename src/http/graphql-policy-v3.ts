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

const principalSubject = (principal: Principal): string =>
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
	_ingress: GraphQLIngress,
	_policy: GraphQLRateLimitPolicyV3
): readonly TokenBucketCheckV3[] =>
	// v3 waits until request cost and principal are known, then evaluates every
	// applicable bucket in one Lua stage. Otherwise a request rejected by its
	// device/workload bucket could still drain the global or shared-NAT bucket.
	[];

/**
 * Trusted requests rejected before cost/principal resolution still pass the
 * global emergency valve exactly once. Valid requests use the full atomic
 * stage below instead, so a denied client/workload never drains global.
 */
export const graphQLV3EarlyFailureRateLimitChecks = (
	policy: GraphQLRateLimitPolicyV3
): readonly TokenBucketCheckV3[] => [globalRequestCheck(policy)];

export type GraphQLV3PrincipalAdmission = {
	readonly audience: "authenticated" | "anonymous" | "workload" | "service" | "legacy";
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
					...(ingress.abuseSubject
						? [
								check({
									id: "mini-ip-abuse-request",
									scope: "client",
									subject: ingress.abuseSubject,
									policy: policy.trafficClasses.mini.abuseRequest,
								}),
							]
						: []),
					check({
						id: authenticated ? "mini-session-weighted" : "mini-device-weighted",
						scope: "client",
						subject: authenticated ? principalSubject(principal) : requiredSubject(ingress),
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
						subject: authenticated ? principalSubject(principal) : requiredSubject(ingress),
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
		case "legacy":
			return {
				audience: "legacy",
				checks: [
					globalRequest,
					check({
						id: "legacy-class-request",
						scope: "client",
						subject: requiredSubject(ingress),
						policy: policy.trafficClasses.legacy.classRequest,
					}),
					check({
						id: "legacy-weighted",
						scope: "client",
						subject: principal ? principalSubject(principal) : requiredSubject(ingress),
						policy: policy.trafficClasses.legacy.weighted,
						cost: boundedCost,
					}),
				],
			};
	}
};
