import type { GraphQLIngress } from "../infra/ingress-context";

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
	if (ingress.class === "unsigned_user_context") {
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
