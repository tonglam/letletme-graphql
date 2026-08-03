import type { GraphQLIngress } from "../infra/ingress-context";
import type { Principal } from "../infra/principal";

export type GraphQLPolicyFailure = {
	status: 401 | 405;
	code: "INVALID_INGRESS_CONTEXT" | "METHOD_NOT_ALLOWED" | "UNTRUSTED_INGRESS";
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

export const graphQLIngressFailure = (
	ingress: GraphQLIngress,
	requireTrustedIngress: boolean
): GraphQLPolicyFailure | null => {
	if (requireTrustedIngress && ingress.class === "unsigned_user_context") {
		return {
			status: 401,
			code: "INVALID_INGRESS_CONTEXT",
			message: "Authenticated website requests require a valid ingress context",
		};
	}
	if (requireTrustedIngress && !ingress.trusted) {
		return {
			status: 401,
			code: "UNTRUSTED_INGRESS",
			message: "GraphQL requests must use a trusted service ingress",
		};
	}
	return null;
};

export const requiresCompatibilityAdmission = (ingress: GraphQLIngress): boolean =>
	!ingress.trusted;

export const graphQLWeightedRateLimitSubject = ({
	ingress,
	principal,
	fallbackSubject,
}: {
	ingress: GraphQLIngress;
	principal: Principal | null;
	fallbackSubject: string;
}): string =>
	ingress.subject ??
	(principal ? `principal:${principal.provider}:${principal.userId}` : fallbackSubject);
