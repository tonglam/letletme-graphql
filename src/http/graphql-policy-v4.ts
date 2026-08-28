import type { GraphQLIngress } from "../infra/ingress-context";
import type { Principal } from "../infra/principal";
import { graphQLPrincipalSubject } from "./graphql-policy-v3";
import type { GraphQLRateLimitPolicyV4 } from "./rate-limit-policy-v4";
import type { TokenBucketPolicy } from "./rate-limit-policy-v3";
import {
	tokenBucketKeyV4,
	type GraphQLRateLimitHeaderScope,
	type TokenBucketCheckV3,
} from "./token-bucket-v3";

const GLOBAL_SUBJECT = "all-graphql-traffic";
const RSC_CLASS_SUBJECT = "all-web-rsc";
const SERVICE_CLASS_SUBJECT = "all-services";

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
	key: tokenBucketKeyV4(id, subject),
	refillPerSecond: policy.refillPerSecond,
	burst: policy.burst,
	cost,
});

const globalRequestCheck = (policy: GraphQLRateLimitPolicyV4): TokenBucketCheckV3 =>
	check({
		id: "v4-global-request",
		scope: "global",
		subject: GLOBAL_SUBJECT,
		policy: policy.global,
	});

export const graphQLV4PreAuthRateLimitChecks = (
	ingress: GraphQLIngress,
	policy: GraphQLRateLimitPolicyV4
): readonly TokenBucketCheckV3[] => {
	if (ingress.trafficClass !== "mini") return [];
	return [
		check({
			id: ingress.abuseSubject ? "mini-v4-ip-abuse-request" : "mini-v4-ingress-request",
			scope: "client",
			subject: ingress.abuseSubject ?? requiredSubject(ingress),
			policy: policy.trafficClasses.mini.abuseRequest,
		}),
	];
};

export const graphQLV4EarlyFailureRateLimitChecks = (
	policy: GraphQLRateLimitPolicyV4
): readonly TokenBucketCheckV3[] => [globalRequestCheck(policy)];

export type GraphQLV4PrincipalAdmission = {
	readonly audience: "authenticated" | "anonymous" | "workload" | "service";
	readonly checks: readonly TokenBucketCheckV3[];
};

export const graphQLV4PrincipalAdmission = ({
	ingress,
	principal,
	cost,
	policy,
}: {
	ingress: GraphQLIngress;
	principal: Principal | null;
	cost: number;
	policy: GraphQLRateLimitPolicyV4;
}): GraphQLV4PrincipalAdmission => {
	const boundedCost = Math.max(1, Math.floor(cost));
	const globalRequest = globalRequestCheck(policy);
	switch (ingress.trafficClass) {
		case "mini": {
			const authenticated = principal !== null;
			const identity = authenticated
				? graphQLPrincipalSubject(principal)
				: requiredSubject(ingress);
			const identityLabel = authenticated ? "session" : "device";
			const workloadPolicy = authenticated
				? policy.trafficClasses.mini.sessionWorkloads[ingress.workload]
				: policy.trafficClasses.mini.anonymousWorkloads[ingress.workload];
			return {
				audience: authenticated ? "authenticated" : "anonymous",
				checks: [
					globalRequest,
					check({
						id: `mini-${identityLabel}-aggregate-weighted`,
						scope: "client",
						subject: identity,
						policy: authenticated
							? policy.trafficClasses.mini.aggregateSessionWeighted
							: policy.trafficClasses.mini.aggregateAnonymousWeighted,
						cost: boundedCost,
					}),
					check({
						id: `mini-${identityLabel}-${ingress.workload}-weighted`,
						scope: "workload",
						subject: `${identity}:${ingress.workload}`,
						policy: workloadPolicy,
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
						id: authenticated
							? "v4-web-browser-session-weighted"
							: "v4-web-browser-anonymous-weighted",
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
						id: "v4-web-rsc-class-request",
						scope: "workload",
						subject: RSC_CLASS_SUBJECT,
						policy: policy.trafficClasses.web_rsc.classRequest,
					}),
					check({
						id: `v4-web-rsc-${ingress.workload}-weighted`,
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
						id: "v4-service-class-request",
						scope: "workload",
						subject: SERVICE_CLASS_SUBJECT,
						policy: policy.trafficClasses.service.classRequest,
					}),
					check({
						id: "v4-service-weighted",
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
