import type { GraphQLIngress } from "../infra/ingress-context";

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

export const hasAuthenticationMaterial = (headers: Headers): boolean =>
	/^bearer\s+\S+$/i.test(headers.get("Authorization") ?? "") ||
	headers.has("X-User-Context") ||
	headers.has("X-User-Context-Sig");
