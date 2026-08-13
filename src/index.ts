import {
	ApolloServer,
	HeaderMap,
	type GraphQLRequestExecutionListener,
	type GraphQLRequestListener,
	type GraphQLRequestListenerParsingDidEnd,
	type GraphQLRequestListenerValidationDidEnd,
} from "@apollo/server";
import { timingSafeEqual } from "crypto";
import depthLimit from "graphql-depth-limit";
import { authorizeGraphQLRequest, graphQLErrorResponse } from "./graphql/authorization";
import type { GraphQLContext } from "./graphql/context";
import { validateGraphQLRequestLimits } from "./graphql/limits";
import { schema } from "./graphql/schema";
import { validateDatabaseContract } from "./infra/database-contract";
import { database } from "./infra/database";
import { coreDatasetRevision, getCoreDataSnapshot } from "./infra/data-snapshot";
import { closeDbPool } from "./infra/db-pool";
import { env } from "./infra/env";
import { logger } from "./infra/logger";
import { classifyGraphQLIngress } from "./infra/ingress-context";
import { metrics, metricsResponse } from "./infra/metrics";
import { getPrincipalFromHeaders, principalToAuthUser, type Principal } from "./infra/principal";
import { closeRedis, connectRedis, getRateLimitRedis, getRedis } from "./infra/redis";
import { CurrentSeasonProvider } from "./infra/season";
import { ReadModelClient } from "./infra/read-model-client";
import {
	checkRateLimits,
	handleRateLimitStorageFailure,
	PayloadTooLargeError,
	readRequestBody,
} from "./http/security";
import {
	graphQLPreAuthRateLimitChecks,
	graphQLPrincipalAdmission,
	graphQLIngressFailure,
	graphQLMethodFailure,
	hasAuthenticationMaterial,
	type GraphQLRateLimitConfig,
} from "./http/graphql-policy";
import {
	extractGraphQLOperationName,
	RequestTiming,
	resolveRequestId,
} from "./http/request-timing";

const currentSeasonProvider = new CurrentSeasonProvider();
const graphQLRateLimitConfig: GraphQLRateLimitConfig = {
	browserIngress: env.GRAPHQL_BROWSER_INGRESS_RATE_LIMIT,
	authenticated: env.GRAPHQL_AUTHENTICATED_RATE_LIMIT,
	anonymous: env.GRAPHQL_ANONYMOUS_RATE_LIMIT,
};

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
		"Access-Control-Allow-Methods": "POST, OPTIONS",
		"Access-Control-Allow-Headers":
			"Content-Type, Authorization, X-Request-Id, X-User-Context, X-User-Context-Sig, X-Ingress-Context, X-Ingress-Context-Sig",
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
	const principal = await getPrincipalFromHeaders(request.headers);
	const user = principal ? principalToAuthUser(principal) : null;
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

const enforceGraphQLRateLimits = async ({
	checks,
	corsHeaders,
}: {
	checks: Parameters<typeof checkRateLimits>[1];
	corsHeaders: Record<string, string>;
}): Promise<Response | null> => {
	let decision: Awaited<ReturnType<typeof checkRateLimits>>;
	try {
		decision = await checkRateLimits(getRateLimitRedis(), checks);
	} catch (error) {
		const storageScope = checks[0]?.scope ?? "graphql-ingress-v2";
		metrics.graphqlRateLimitDecisions.labels(storageScope, "storage_unavailable").inc();
		try {
			decision = handleRateLimitStorageFailure({
				error,
				failClosed: true,
				scope: storageScope,
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

	if (!decision.allowed) {
		metrics.graphqlRateLimitDecisions
			.labels(decision.deniedScope ?? "graphql-admission", "limited")
			.inc();
		return jsonError(429, "RATE_LIMITED", "Too many requests", corsHeaders, {
			"Retry-After": String(decision.retryAfterSeconds),
		});
	}

	for (const scope of new Set(checks.map((check) => check.scope))) {
		metrics.graphqlRateLimitDecisions.labels(scope, "allowed").inc();
	}
	return null;
};

async function healthCheck(): Promise<{ ok: boolean; body: string }> {
	const checks: Record<string, string> = {};

	try {
		const redis = getRedis();
		const pong = await redis.ping();
		checks.redis = pong === "PONG" ? "ok" : "fail";
	} catch {
		checks.redis = "fail";
	}

	try {
		await database.query("SELECT 1");
		checks.postgres = "ok";
		currentSeasonProvider.get();
		checks.season = "ok";
	} catch {
		checks.postgres = "fail";
		checks.season = "fail";
	}

	const ok = Object.values(checks).every((v) => v === "ok");
	return { ok, body: JSON.stringify({ status: ok ? "ok" : "degraded", checks }) };
}

const startServer = async (): Promise<void> => {
	const contract = await validateDatabaseContract(database);
	currentSeasonProvider.seed(contract.currentSeason);
	await connectRedis();
	logger.info(
		{
			role: contract.roleName,
			season: contract.currentSeason.seasonCode,
			datasetRevision: contract.datasetRevision,
		},
		"Data Platform database contract accepted"
	);

	if (!env.METRICS_TOKEN) {
		logger.warn("METRICS_TOKEN is empty — /metrics scraping is disabled");
	}
	if (!env.BACKEND_PROXY_SECRET) {
		logger.warn("BACKEND_PROXY_SECRET is empty — website X-User-Context principals are disabled");
	}
	if (!env.GRAPHQL_SERVICE_TOKEN) {
		logger.warn("GRAPHQL_SERVICE_TOKEN is empty — trusted public server reads are disabled");
	}

	const apollo = new ApolloServer<GraphQLContext>({
		schema,
		introspection: !env.isProduction,
		validationRules: [depthLimit(10)],
		plugins: [
			{
				async requestDidStart(): Promise<GraphQLRequestListener<GraphQLContext>> {
					return {
						async parsingDidStart(requestContext): Promise<GraphQLRequestListenerParsingDidEnd> {
							const stop = requestContext.contextValue.requestTiming?.start("apolloParse");
							return async (): Promise<void> => {
								stop?.();
							};
						},
						async validationDidStart(
							requestContext
						): Promise<GraphQLRequestListenerValidationDidEnd> {
							const stop = requestContext.contextValue.requestTiming?.start("apolloValidate");
							return async (): Promise<void> => {
								stop?.();
							};
						},
						async executionDidStart(
							requestContext
						): Promise<GraphQLRequestExecutionListener<GraphQLContext>> {
							const stop = requestContext.contextValue.requestTiming?.start("apolloExecute");
							return {
								async executionDidEnd(): Promise<void> {
									stop?.();
								},
							};
						},
					};
				},
			},
		],
	});

	await apollo.start();

	const server = Bun.serve({
		port: env.PORT,
		fetch: async (request: Request) => {
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

			if (url.pathname === "/graphql") {
				const requestTiming = new RequestTiming();
				const requestId = resolveRequestId(request.headers.get("X-Request-Id"));
				let operationName = "anonymous";
				let ingressClass = "unclassified";
				let rateLimitAudience = "unresolved";
				const finalizeGraphQLResponse = (response: Response, outcome: string): Response => {
					const durationMs = requestTiming.elapsedMs();
					response.headers.set("X-Request-Id", requestId);
					metrics.httpRequestDurationSeconds
						.labels(request.method, url.pathname, String(response.status))
						.observe(durationMs / 1000);
					logger.info(
						{
							requestId,
							operationName,
							ingressClass,
							rateLimitAudience,
							outcome,
							method: request.method,
							path: url.pathname,
							status: response.status,
							durationMs: Number(durationMs.toFixed(2)),
							timings: requestTiming.snapshot(),
						},
						"GraphQL request timing"
					);
					return response;
				};

				try {
					const methodFailure = graphQLMethodFailure(request.method);
					if (methodFailure) {
						return finalizeGraphQLResponse(
							jsonError(
								methodFailure.status,
								methodFailure.code,
								methodFailure.message,
								corsHeaders,
								{ Allow: "POST, OPTIONS" }
							),
							"method_rejected"
						);
					}

					const ingress = requestTiming.measureSync("ingressClassification", () =>
						classifyGraphQLIngress(request.headers)
					);
					ingressClass = ingress.class;
					metrics.graphqlIngressRequests.labels(ingress.class).inc();
					const ingressFailure = graphQLIngressFailure(ingress);
					if (ingressFailure) {
						return finalizeGraphQLResponse(
							jsonError(
								ingressFailure.status,
								ingressFailure.code,
								ingressFailure.message,
								corsHeaders
							),
							"ingress_rejected"
						);
					}

					const body = await requestTiming.measure("bodyRead", () => readRequestBody(request));
					let parsedBody: unknown = undefined;
					if (body) {
						try {
							parsedBody = requestTiming.measureSync(
								"jsonParse",
								() => JSON.parse(body) as unknown
							);
						} catch {
							return finalizeGraphQLResponse(
								new Response(JSON.stringify({ errors: [{ message: "Invalid JSON" }] }), {
									status: 400,
									headers: {
										"Content-Type": "application/json",
										...corsHeaders,
									},
								}),
								"invalid_json"
							);
						}
					}
					operationName = extractGraphQLOperationName(parsedBody);

					const limits = requestTiming.measureSync("requestLimits", () =>
						validateGraphQLRequestLimits(parsedBody, schema)
					);
					if (!limits.ok) {
						return finalizeGraphQLResponse(
							jsonError(400, limits.code, limits.message, corsHeaders),
							"request_limits_rejected"
						);
					}
					const { principal, user } = await requestTiming.measure("principal", () =>
						resolvePrincipalAndUser(request)
					);
					if (!principal && hasAuthenticationMaterial(request.headers)) {
						return finalizeGraphQLResponse(
							jsonError(
								401,
								"INVALID_AUTH_CONTEXT",
								"Authentication context is invalid or expired",
								corsHeaders
							),
							"authentication_rejected"
						);
					}

					const principalAdmission = graphQLPrincipalAdmission({
						ingress,
						principal,
						cost: limits.rateLimitCostUnits,
						config: graphQLRateLimitConfig,
					});
					rateLimitAudience = principalAdmission.audience;
					const admissionFailure = await requestTiming.measure("admission", () =>
						enforceGraphQLRateLimits({
							checks: [
								...graphQLPreAuthRateLimitChecks(ingress, graphQLRateLimitConfig),
								principalAdmission.check,
							],
							corsHeaders,
						})
					);
					if (admissionFailure) {
						return finalizeGraphQLResponse(admissionFailure, "admission_rejected");
					}

					const currentSeason = currentSeasonProvider.get();
					const data = new ReadModelClient(database, currentSeason);
					const authorization = await requestTiming.measure("authorization", () =>
						authorizeGraphQLRequest({
							body: parsedBody,
							searchParams: url.searchParams,
							principal,
							data,
							logger,
						})
					);
					if (!authorization.ok) {
						return finalizeGraphQLResponse(
							graphQLErrorResponse(authorization, corsHeaders),
							"authorization_rejected"
						);
					}

					const graphQLContext: GraphQLContext = {
						data,
						database,
						currentSeason,
						redis: getRedis(),
						logger,
						requestId,
						operationName,
						requestTiming,
						requestScope: {},
						principal: principal ?? undefined,
						user: user ?? undefined,
					};
					const lightweightCoreFields = new Set([
						"event",
						"events",
						"eventFixtures",
						"currentEventInfo",
						"coreEventContext",
						"playerStatsBootstrap",
						"playersForPicker",
						"playerStatsDesk",
					]);
					const lightweightCoreRead =
						limits.shape === "query" &&
						limits.rootFields.length > 0 &&
						limits.rootFields.every((field) => lightweightCoreFields.has(field));
					if (!lightweightCoreRead) {
						try {
							graphQLContext.dataRevision = await requestTiming.measure("publication", async () =>
								coreDatasetRevision(await getCoreDataSnapshot(graphQLContext))
							);
						} catch (error) {
							logger.error({ err: error }, "Data publication authority is unavailable");
							return finalizeGraphQLResponse(
								jsonError(
									503,
									"DATA_PUBLICATION_UNAVAILABLE",
									"Data publication is temporarily unavailable",
									corsHeaders
								),
								"publication_unavailable"
							);
						}
					}

					const headers = new HeaderMap();
					request.headers.forEach((value, key) => {
						headers.set(key, value);
					});

					const httpGraphQLResponse = await requestTiming.measure("apollo", () =>
						apollo.executeHTTPGraphQLRequest({
							httpGraphQLRequest: {
								method: request.method.toUpperCase(),
								headers,
								body: parsedBody,
								search: "",
							},
							context: async () => graphQLContext,
						})
					);

					const stopResponseBuild = requestTiming.start("responseBuild");

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
						"X-Request-Id": requestId,
					};

					const response = new Response(responseBody, {
						status: httpGraphQLResponse.status || 200,
						headers: finalHeaders,
					});
					stopResponseBuild();

					return finalizeGraphQLResponse(
						response,
						response.status >= 400 ? "graphql_error" : "completed"
					);
				} catch (error) {
					if (error instanceof PayloadTooLargeError) {
						return finalizeGraphQLResponse(
							jsonError(413, error.code, error.message, corsHeaders),
							"payload_too_large"
						);
					}
					logger.error(
						{
							err: error,
							requestId,
							operationName,
							durationMs: Number(requestTiming.elapsedMs().toFixed(2)),
							timings: requestTiming.snapshot(),
						},
						"GraphQL request failed"
					);
					return finalizeGraphQLResponse(
						new Response(
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
						),
						"internal_error"
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
