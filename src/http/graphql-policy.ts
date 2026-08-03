import { createHash } from "crypto";
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
	ingress.class === "unsigned_bearer" || ingress.class === "unsigned_user_context";

const principalSubject = (principal: Principal): string =>
	`principal:${principal.provider}:${principal.userId}`;

const fingerprint = (value: string): string => createHash("sha256").update(value).digest("hex");

export const graphQLCompatibilityAdmissionSubject = ({
	headers,
	ingress,
	principal,
	fallbackSubject,
}: {
	headers: Headers;
	ingress: GraphQLIngress;
	principal: Principal | null;
	fallbackSubject: string;
}): string => {
	if (principal) return principalSubject(principal);

	const bearerToken = headers.get("Authorization")?.match(/^bearer\s+(\S+)$/i)?.[1];
	if (bearerToken) return `credential:bearer:${fingerprint(bearerToken)}`;

	if (ingress.class === "unsigned_user_context") {
		const context = headers.get("X-User-Context") ?? "";
		const signature = headers.get("X-User-Context-Sig") ?? "";
		if (context || signature) {
			return `credential:user-context:${fingerprint(`${context}\0${signature}`)}`;
		}
	}

	return `peer:${fallbackSubject}`;
};

export const GRAPHQL_GLOBAL_ADMISSION_SUBJECT = "all-graphql-traffic";
export const GRAPHQL_COMPATIBILITY_PUBLIC_RATE_LIMIT_SUBJECT = "shared-public:compat-anonymous";

export const graphQLUsesSharedPublicBudget = (ingress: GraphQLIngress): boolean =>
	ingress.class === "service" || ingress.class === "anonymous";

export const graphQLAdmissionSubjects = ({
	headers,
	ingress,
	principal,
	fallbackSubject,
}: {
	headers: Headers;
	ingress: GraphQLIngress;
	principal: Principal | null;
	fallbackSubject: string;
}): { global: string; ingress: string | null; prechargesWeightedBudget: boolean } => {
	const ingressSubject =
		ingress.subject ??
		(requiresCompatibilityAdmission(ingress)
			? graphQLCompatibilityAdmissionSubject({
					headers,
					ingress,
					principal,
					fallbackSubject,
				})
			: null);
	return {
		global: GRAPHQL_GLOBAL_ADMISSION_SUBJECT,
		ingress: ingressSubject,
		// Signed/service subjects and validated website principals are also the
		// eventual weighted subject, so their pre-authorization unit can be charged
		// directly to that budget. Unvalidated bearer fingerprints cannot.
		prechargesWeightedBudget: Boolean(ingress.subject || principal),
	};
};

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
	(ingress.class === "anonymous"
		? GRAPHQL_COMPATIBILITY_PUBLIC_RATE_LIMIT_SUBJECT
		: principal
			? principalSubject(principal)
			: fallbackSubject);
