import { ApolloServer, HeaderMap } from "@apollo/server";
import { timingSafeEqual } from "crypto";
import depthLimit from "graphql-depth-limit";
import { authorizeGraphQLRequest, graphQLErrorResponse } from "./graphql/authorization";
import type { GraphQLContext } from "./graphql/context";
import { parseGraphQLGetLimitPayload, validateGraphQLRequestLimits } from "./graphql/limits";
import { schema } from "./graphql/schema";
import { closeDbPool, dbPool } from "./infra/db-pool";
import { validateDeviceToken } from "./infra/device-auth";
import { env } from "./infra/env";
import { logger } from "./infra/logger";
import { verifyIngressContext } from "./infra/ingress-context";
import { metrics, metricsResponse } from "./infra/metrics";
import { getPrincipalFromHeaders, principalToAuthUser, type Principal } from "./infra/principal";
import { closeRedis, connectRedis, getRedis } from "./infra/redis";
import { ACTIVE_SEASON_KEY, parseSeason } from "./infra/season";
import { supabase } from "./infra/supabase";
import {
	checkRateLimit,
	handleRateLimitStorageFailure,
	PayloadTooLargeError,
	rateLimitKey,
	readRequestBody,
	resolveClientIp,
} from "./http/security";

const GRAPHQL_RATE_LIMIT = 120;
const SECURITY_OPERATION_RATE_LIMIT = 5;
const RATE_LIMIT_WINDOW_SECONDS = 60;

function getCorsHeaders(origin: string | null): Record<string, string> {
	const configuredOrigins = env.CORS_ORIGIN.split(",")
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
	const allowedOrigin = configuredOrigins.includes("*")
		? origin || "*"
		: origin && configuredOrigins.includes(origin)
			? origin
			: (configuredOrigins[0] ?? "null");

	const headers: Record<string, string> = {
		"Access-Control-Allow-Origin": allowedOrigin,
		Vary: "Origin",
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Allow-Headers":
			"Content-Type, Authorization, X-User-Context, X-User-Context-Sig, X-Ingress-Context, X-Ingress-Context-Sig",
		"Access-Control-Max-Age": "86400",
	};

	if (env.CORS_CREDENTIALS) {
		headers["Access-Control-Allow-Credentials"] = "true";
	}

	return headers;
}

function metricsTokenMatches(provided: string | undefined): boolean {
	if (!env.METRICS_TOKEN || !provided) return false;
	const expected = Buffer.from(env.METRICS_TOKEN);
	const actual = Buffer.from(provided);
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function resolvePrincipalAndUser(
	request: Request
): Promise<{ principal: Principal | null; user: ReturnType<typeof principalToAuthUser> | null }> {
	let principal = await getPrincipalFromHeaders(request.headers);
	let user = principal ? principalToAuthUser(principal) : null;

	if (!principal) {
		const authHeader = request.headers.get("Authorization");
		const token = authHeader?.match(/^bearer\s+(.+)$/i)?.[1]?.trim();
		if (token) {
			const deviceUser = await validateDeviceToken(token);
			if (deviceUser) {
				principal = {
					userId: deviceUser.id,
					source: "device",
					provider: "device",
					fplEntryId: null,
					fplEntryVerifiedAt: null,
				};
				user = deviceUser;
				metrics.authTokenValidations.labels("legacy_device").inc();
			}
		}
	}

	return { principal, user };
}

const jsonError = (
	status: number,
	code: string,
	message: string,
	corsHeaders: Record<string, string>,
	extraHeaders: Record<string, string> = {}
): Response =>
	new Response(JSON.stringify({ errors: [{ message, extensions: { code } }] }), {
		status,
		headers: {
			"Content-Type": "application/json",
			...extraHeaders,
			...corsHeaders,
		},
	});

async function healthCheck(): Promise<{ ok: boolean; body: string }> {
	const checks: Record<string, string> = {};

	try {
		const redis = getRedis();
		const pong = await redis.ping();
		checks.redis = pong === "PONG" ? "ok" : "fail";
		const season = parseSeason(await redis.get(ACTIVE_SEASON_KEY));
		checks.season = season ? "ok" : "fail";
	} catch {
		checks.redis = "fail";
		checks.season = "fail";
	}

	try {
		await dbPool.query("SELECT 1");
		checks.postgres = "ok";
	} catch {
		checks.postgres = "fail";
	}

	const ok = Object.values(checks).every((v) => v === "ok");
	return { ok, body: JSON.stringify({ status: ok ? "ok" : "degraded", checks }) };
}

const startServer = async (): Promise<void> => {
	await connectRedis();

	if (!env.METRICS_TOKEN) {
		logger.warn("METRICS_TOKEN is empty — /metrics scraping is disabled");
	}
	if (!env.BACKEND_PROXY_SECRET) {
		logger.warn("BACKEND_PROXY_SECRET is empty — website X-User-Context principals are disabled");
	}

	const apollo = new ApolloServer<GraphQLContext>({
		schema,
		introspection: !env.isProduction,
		validationRules: [depthLimit(10)],
	});

	await apollo.start();

	const server = Bun.serve({
		port: env.PORT,
		fetch: async (request: Request, bunServer) => {
			const url = new URL(request.url);
			const origin = request.headers.get("Origin");
			const corsHeaders = getCorsHeaders(origin);

			if (request.method === "OPTIONS") {
				return new Response(null, {
					status: 204,
					headers: corsHeaders,
				});
			}

			if (url.pathname === "/health") {
				const health = await healthCheck();
				return new Response(health.body, {
					status: health.ok ? 200 : 503,
					headers: {
						"Content-Type": "application/json",
						...corsHeaders,
					},
				});
			}

			if (url.pathname === "/metrics") {
				const metricsToken =
					request.headers.get("X-Metrics-Token") ??
					request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
				if (!metricsTokenMatches(metricsToken)) {
					return new Response("Not Found", {
						status: 404,
						headers: corsHeaders,
					});
				}
				return metricsResponse();
			}

			if (url.pathname === "/api/device/auth" && request.method === "POST") {
				return jsonError(
					410,
					"DEVICE_AUTH_RETIRED",
					"New device sessions are no longer issued; authenticate through letletme-web",
					corsHeaders
				);
			}

			if (url.pathname === "/graphql") {
				const start = performance.now();

				try {
					const body = await readRequestBody(request);
					let parsedBody: unknown = undefined;
					if (body) {
						try {
							parsedBody = JSON.parse(body);
						} catch {
							return new Response(JSON.stringify({ errors: [{ message: "Invalid JSON" }] }), {
								status: 400,
								headers: {
									"Content-Type": "application/json",
									...corsHeaders,
								},
							});
						}
					}

					const getPayload =
						parsedBody === undefined ? parseGraphQLGetLimitPayload(url.searchParams) : null;
					if (getPayload && !getPayload.ok) {
						return jsonError(
							400,
							"INVALID_GRAPHQL_VARIABLES",
							"GraphQL variables query parameter must be valid JSON",
							corsHeaders
						);
					}
					const limitInput = parsedBody ?? (getPayload?.ok ? getPayload.payload : undefined);
					const limits = validateGraphQLRequestLimits(limitInput);
					if (!limits.ok) {
						return jsonError(400, limits.code, limits.message, corsHeaders);
					}

					const peerAddress = bunServer.requestIP(request)?.address;
					const clientIp = resolveClientIp(request.headers, peerAddress, env.TRUSTED_PROXY_HOPS);
					const ingressContext = verifyIngressContext(request.headers);
					if (
						env.REQUIRE_SIGNED_WEB_INGRESS &&
						request.headers.has("X-User-Context") &&
						!ingressContext
					) {
						return jsonError(
							401,
							"INVALID_INGRESS_CONTEXT",
							"Authenticated website requests require a valid ingress context",
							corsHeaders
						);
					}
					const rateLimitSubject = ingressContext?.subject ?? clientIp;
					// Only a parsed, read-only query may fail open if Redis is unavailable.
					// Malformed/unknown operations and mutations must fail closed.
					const failClosed = limits.shape !== "query" || limits.securityOperation;
					let requestRate;
					try {
						requestRate = await checkRateLimit(
							getRedis(),
							rateLimitKey("graphql", rateLimitSubject),
							GRAPHQL_RATE_LIMIT,
							RATE_LIMIT_WINDOW_SECONDS
						);
					} catch (error) {
						try {
							requestRate = handleRateLimitStorageFailure({
								error,
								failClosed,
								scope: "graphql",
								logger,
							});
						} catch {
							return jsonError(
								503,
								"RATE_LIMIT_STORAGE_UNAVAILABLE",
								"Request safety checks are temporarily unavailable",
								corsHeaders
							);
						}
					}
					if (!requestRate.allowed) {
						return jsonError(429, "RATE_LIMITED", "Too many requests", corsHeaders, {
							"Retry-After": String(requestRate.retryAfterSeconds),
						});
					}

					if (limits.securityOperation) {
						try {
							const securityRate = await checkRateLimit(
								getRedis(),
								rateLimitKey("legacy-session", rateLimitSubject),
								SECURITY_OPERATION_RATE_LIMIT,
								RATE_LIMIT_WINDOW_SECONDS,
								limits.securityOperationCount
							);
							if (!securityRate.allowed) {
								return jsonError(429, "RATE_LIMITED", "Too many session attempts", corsHeaders, {
									"Retry-After": String(securityRate.retryAfterSeconds),
								});
							}
						} catch (error) {
							try {
								handleRateLimitStorageFailure({
									error,
									failClosed: true,
									scope: "legacy-session",
									logger,
								});
							} catch {
								return jsonError(
									503,
									"RATE_LIMIT_STORAGE_UNAVAILABLE",
									"Request safety checks are temporarily unavailable",
									corsHeaders
								);
							}
						}
					}
					const headers = new HeaderMap();
					request.headers.forEach((value, key) => {
						headers.set(key, value);
					});

					const { principal, user } = await resolvePrincipalAndUser(request);
					const authorization = await authorizeGraphQLRequest({
						body: parsedBody,
						searchParams: url.searchParams,
						principal,
						supabase,
						logger,
					});
					if (!authorization.ok) {
						return graphQLErrorResponse(authorization, corsHeaders);
					}

					const httpGraphQLResponse = await apollo.executeHTTPGraphQLRequest({
						httpGraphQLRequest: {
							method: request.method.toUpperCase(),
							headers,
							body: parsedBody,
							search: url.search,
						},
						context: async () => ({
							supabase,
							redis: getRedis(),
							logger,
							principal: principal ?? undefined,
							user: user ?? undefined,
						}),
					});

					const durationMs = performance.now() - start;

					const responseHeaders: Record<string, string> = {};
					for (const [key, value] of httpGraphQLResponse.headers) {
						responseHeaders[key] = value;
					}

					let responseBody: string | ReadableStream;
					if (httpGraphQLResponse.body.kind === "complete") {
						responseBody = httpGraphQLResponse.body.string;
					} else {
						const { asyncIterator } = httpGraphQLResponse.body;
						responseBody = new ReadableStream({
							async start(controller): Promise<void> {
								for await (const chunk of asyncIterator) {
									controller.enqueue(new TextEncoder().encode(chunk));
								}
								controller.close();
							},
						});
					}

					const finalHeaders = {
						...responseHeaders,
						...corsHeaders,
					};

					const response = new Response(responseBody, {
						status: httpGraphQLResponse.status || 200,
						headers: finalHeaders,
					});

					metrics.httpRequestDurationSeconds
						.labels(request.method, url.pathname, String(response.status))
						.observe(durationMs / 1000);

					logger.info(
						{
							method: request.method,
							path: url.pathname,
							status: response.status,
							durationMs: Number(durationMs.toFixed(2)),
						},
						"request"
					);

					return response;
				} catch (error) {
					if (error instanceof PayloadTooLargeError) {
						return jsonError(413, error.code, error.message, corsHeaders);
					}
					logger.error({ err: error }, "GraphQL request failed");
					return new Response(
						JSON.stringify({
							errors: [{ message: "Internal server error" }],
						}),
						{
							status: 500,
							headers: {
								"Content-Type": "application/json",
								...corsHeaders,
							},
						}
					);
				}
			}

			return new Response("Not Found", {
				status: 404,
				headers: corsHeaders,
			});
		},
	});

	const shutdown = async (signal: string): Promise<void> => {
		logger.info({ signal }, "Shutting down");
		try {
			server.stop();
			await apollo.stop();
			await closeRedis();
			await closeDbPool();
		} catch (error) {
			logger.error({ err: error }, "Error during shutdown");
		}
		process.exit(0);
	};

	process.on("SIGTERM", () => {
		void shutdown("SIGTERM");
	});
	process.on("SIGINT", () => {
		void shutdown("SIGINT");
	});

	logger.info({ port: env.PORT }, "Apollo Server started");
	logger.info({ url: `http://localhost:${env.PORT}/graphql` }, "GraphQL endpoint ready");
};

startServer().catch((error: unknown) => {
	logger.error({ err: error }, "Failed to start server");
	process.exit(1);
});
