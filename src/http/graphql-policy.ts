import { type GraphQLIngress, WEB_PUBLIC_RSC_RATE_LIMIT_SUBJECT } from "../infra/ingress-context";
import type { Principal } from "../infra/principal";
import { rateLimitKey, type RateLimitCheck } from "./security";

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

export const GRAPHQL_RATE_LIMIT_WINDOW_SECONDS = 60;
export const GRAPHQL_GLOBAL_ADMISSION_RATE_LIMIT = 1_500;
export const GRAPHQL_SHARED_PUBLIC_RATE_LIMIT = 1_200;
export const GRAPHQL_GLOBAL_ADMISSION_SUBJECT = "all-graphql-traffic";

export const GRAPHQL_RATE_LIMIT_SCOPES = {
	ingress: "graphql-ingress-v2",
	authenticated: "graphql-authenticated-v2",
	anonymous: "graphql-anonymous-v2",
	sharedPublic: "graphql-shared-public-v2",
} as const;

const GRAPHQL_SHARED_PUBLIC_SUBJECT = "all-public-rsc-and-service";

export type GraphQLRateLimitConfig = {
	readonly browserIngress: number;
	readonly authenticated: number;
	readonly anonymous: number;
};

const principalSubject = (principal: Principal): string =>
	`principal:${principal.provider}:${principal.userId}`;

const ingressSubject = (ingress: GraphQLIngress): string =>
	ingress.subject ?? `missing:${ingress.class}`;

export const graphQLUsesSharedPublicBudget = (ingress: GraphQLIngress): boolean =>
	ingress.class === "service" ||
	(ingress.class === "signed" && ingress.subject === WEB_PUBLIC_RSC_RATE_LIMIT_SUBJECT);

/**
 * Request-count admission runs before any principal verification. The global
 * and caller buckets are charged atomically with a fixed cost of one.
 */
export const graphQLPreAuthRateLimitChecks = (
	ingress: GraphQLIngress,
	config: GraphQLRateLimitConfig
): readonly RateLimitCheck[] => {
	const sharedPublic = graphQLUsesSharedPublicBudget(ingress);
	return [
		{
			scope: GRAPHQL_RATE_LIMIT_SCOPES.ingress,
			key: rateLimitKey(
				GRAPHQL_RATE_LIMIT_SCOPES.ingress,
				`global:${GRAPHQL_GLOBAL_ADMISSION_SUBJECT}`
			),
			limit: GRAPHQL_GLOBAL_ADMISSION_RATE_LIMIT,
			windowSeconds: GRAPHQL_RATE_LIMIT_WINDOW_SECONDS,
			cost: 1,
		},
		{
			scope: sharedPublic
				? GRAPHQL_RATE_LIMIT_SCOPES.sharedPublic
				: GRAPHQL_RATE_LIMIT_SCOPES.ingress,
			key: rateLimitKey(
				sharedPublic ? GRAPHQL_RATE_LIMIT_SCOPES.sharedPublic : GRAPHQL_RATE_LIMIT_SCOPES.ingress,
				sharedPublic
					? `ingress:${GRAPHQL_SHARED_PUBLIC_SUBJECT}`
					: `ingress:${ingressSubject(ingress)}`
			),
			limit: sharedPublic ? GRAPHQL_SHARED_PUBLIC_RATE_LIMIT : config.browserIngress,
			windowSeconds: GRAPHQL_RATE_LIMIT_WINDOW_SECONDS,
			cost: 1,
		},
	];
};

export type GraphQLPrincipalAdmission = {
	readonly audience: "authenticated" | "anonymous" | "shared_public";
	readonly check: RateLimitCheck;
};

/** Complexity-weighted admission is deliberately resolved only after auth. */
export const graphQLPrincipalAdmission = ({
	ingress,
	principal,
	cost,
	config,
}: {
	ingress: GraphQLIngress;
	principal: Principal | null;
	cost: number;
	config: GraphQLRateLimitConfig;
}): GraphQLPrincipalAdmission => {
	const boundedCost = Math.max(1, Math.floor(cost));
	if (graphQLUsesSharedPublicBudget(ingress)) {
		return {
			audience: "shared_public",
			check: {
				scope: GRAPHQL_RATE_LIMIT_SCOPES.sharedPublic,
				key: rateLimitKey(
					GRAPHQL_RATE_LIMIT_SCOPES.sharedPublic,
					`weighted:${GRAPHQL_SHARED_PUBLIC_SUBJECT}`
				),
				limit: GRAPHQL_SHARED_PUBLIC_RATE_LIMIT,
				windowSeconds: GRAPHQL_RATE_LIMIT_WINDOW_SECONDS,
				cost: boundedCost,
			},
		};
	}

	if (principal) {
		return {
			audience: "authenticated",
			check: {
				scope: GRAPHQL_RATE_LIMIT_SCOPES.authenticated,
				key: rateLimitKey(GRAPHQL_RATE_LIMIT_SCOPES.authenticated, principalSubject(principal)),
				limit: config.authenticated,
				windowSeconds: GRAPHQL_RATE_LIMIT_WINDOW_SECONDS,
				cost: boundedCost,
			},
		};
	}

	return {
		audience: "anonymous",
		check: {
			scope: GRAPHQL_RATE_LIMIT_SCOPES.anonymous,
			key: rateLimitKey(GRAPHQL_RATE_LIMIT_SCOPES.anonymous, `weighted:${ingressSubject(ingress)}`),
			limit: config.anonymous,
			windowSeconds: GRAPHQL_RATE_LIMIT_WINDOW_SECONDS,
			cost: boundedCost,
		},
	};
};

export const hasAuthenticationMaterial = (headers: Headers): boolean =>
	/^bearer\s+\S+$/i.test(headers.get("Authorization") ?? "") ||
	headers.has("X-User-Context") ||
	headers.has("X-User-Context-Sig");
