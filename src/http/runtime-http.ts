import { timingSafeEqual } from "node:crypto";
import { env } from "../infra/env";

export type GraphQLMetricResult =
	"ok" | "rate_limited" | "graphql_error" | "client_error" | "server_error";

export const getCorsHeaders = (origin: string | null): Record<string, string> => {
	const configuredOrigins = env.CORS_ORIGIN.split(",")
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
	const allowedOrigin = configuredOrigins.includes("*")
		? origin || "*"
		: origin && configuredOrigins.includes(origin)
			? origin
			: (configuredOrigins[0] ?? "null");

	return {
		"Access-Control-Allow-Origin": allowedOrigin,
		Vary: "Origin",
		"Access-Control-Allow-Methods": "POST, OPTIONS",
		"Access-Control-Allow-Headers":
			"Content-Type, Authorization, X-Request-Id, X-LetLetMe-Contract, X-User-Context, X-User-Context-Sig, X-Ingress-Context, X-Ingress-Context-Sig",
		"Access-Control-Expose-Headers":
			"X-Request-Id, X-LetLetMe-Contract, Retry-After, X-RateLimit-Policy, X-RateLimit-Scope, X-RateLimit-Workload, X-RateLimit-Shadow-Outcome, X-RateLimit-Shadow-Scope",
		"Access-Control-Max-Age": "86400",
	};
};

export const metricsTokenMatches = (provided: string | undefined): boolean => {
	if (!env.METRICS_TOKEN || !provided) return false;
	const expected = Buffer.from(env.METRICS_TOKEN);
	const actual = Buffer.from(provided);
	return expected.length === actual.length && timingSafeEqual(expected, actual);
};

export const jsonError = (
	status: number,
	code: string,
	message: string,
	corsHeaders: Record<string, string>,
	extraHeaders: Record<string, string> = {}
): Response =>
	new Response(
		JSON.stringify({
			errors: [
				{
					message,
					extensions: {
						code,
						requestId: corsHeaders["X-Request-Id"] ?? "unavailable",
					},
				},
			],
		}),
		{
			status,
			headers: {
				"Content-Type": "application/json",
				...extraHeaders,
				...corsHeaders,
			},
		}
	);

export const graphQLMetricResult = (response: Response, outcome: string): GraphQLMetricResult => {
	if (response.status === 429) return "rate_limited";
	if (outcome === "graphql_error") return "graphql_error";
	if (response.status >= 500) return "server_error";
	if (response.status >= 400) return "client_error";
	return "ok";
};
