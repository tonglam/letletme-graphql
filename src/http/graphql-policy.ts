import type { GraphQLIngress } from "../infra/ingress-context";
import type { Principal } from "../infra/principal";

export type GraphQLPolicyFailure = {
	status: 401 | 405;
	code: "METHOD_NOT_ALLOWED" | "UNTRUSTED_INGRESS";
	message: string;
};

export const graphQLMethodFailure = (method: string): GraphQLPolicyFailure | null =>
	method === "POST" || method === "OPTIONS"
		? null
		: {
				status: 405,
				code: "METHOD_NOT_ALLOWED",
				message: "GraphQL requests must use POST",
			};

export const graphQLIngressFailure = (ingress: GraphQLIngress): GraphQLPolicyFailure | null => {
	if (!ingress.trusted) {
		return {
			status: 401,
			code: "UNTRUSTED_INGRESS",
			message: "GraphQL requests must use a trusted service ingress",
		};
	}
	return null;
};

const principalSubject = (principal: Principal): string =>
	`principal:${principal.provider}:${principal.userId}`;

export const GRAPHQL_GLOBAL_ADMISSION_SUBJECT = "all-graphql-traffic";

export const graphQLUsesSharedPublicBudget = (ingress: GraphQLIngress): boolean =>
	ingress.class === "service";

export const shouldPrechargeResolvedPrincipal = (
	principal: Principal | null,
	weightedRatePrecharged: boolean
): boolean => Boolean(principal) && !weightedRatePrecharged;

export const graphQLAdmissionSubjects = ({
	ingress,
	principal,
}: {
	ingress: GraphQLIngress;
	principal: Principal | null;
}): { global: string; ingress: string | null; prechargesWeightedBudget: boolean } => {
	const ingressSubject = ingress.subject ?? (principal ? principalSubject(principal) : null);
	return {
		global: GRAPHQL_GLOBAL_ADMISSION_SUBJECT,
		ingress: ingressSubject,
		// Trusted ingress subjects are also the eventual weighted subject.
		prechargesWeightedBudget: Boolean(ingress.subject || principal),
	};
};

export const graphQLWeightedRateLimitSubject = ({
	ingress,
	principal,
}: {
	ingress: GraphQLIngress;
	principal: Principal | null;
}): string => ingress.subject ?? (principal ? principalSubject(principal) : "trusted-ingress");
