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
import { database, databaseHealthCheck } from "./infra/database";
import { coreDatasetRevision, getCoreDataSnapshot } from "./infra/data-snapshot";
import { closeDbPool, dbPool } from "./infra/db-pool";
import { env } from "./infra/env";
import { logger } from "./infra/logger";
import { classifyGraphQLIngress, type GraphQLIngress } from "./infra/ingress-context";
import { metrics, metricsResponse, registerDatabasePoolMetrics } from "./infra/metrics";
import {
	rateLimitFingerprint,
	recordRateLimitAggregate,
	type RateLimitAggregateOutcome,
} from "./infra/rate-limit-observability";
import { getPrincipalFromHeaders, principalToAuthUser, type Principal } from "./infra/principal";
import { closeRedis, connectRedis, getRateLimitRedis, getRedis } from "./infra/redis";
import { CurrentSeasonProvider } from "./infra/season";
import { ReadModelClient } from "./infra/read-model-client";
import {
	checkRateLimits,
	handleRateLimitStorageFailure,
	PayloadTooLargeError,
	readRequestBody,
	type RateLimitBatchResult,
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
	graphQLV3EarlyFailureRateLimitChecks,
	graphQLV3PreAuthRateLimitChecks,
	graphQLV3PrincipalAdmission,
} from "./http/graphql-policy-v3";
import {
	graphQLV4EarlyFailureRateLimitChecks,
	graphQLV4PreAuthRateLimitChecks,
	graphQLV4PrincipalAdmission,
} from "./http/graphql-policy-v4";
import {
	assertGraphQLRateLimitModeCanStart,
	productionGraphQLRateLimitPolicy,
} from "./http/rate-limit-policy-v3";
import {
	assertGraphQLRateLimitV4ModeCanStart,
	productionGraphQLRateLimitPolicyV4,
} from "./http/rate-limit-policy-v4";
import {
	checkTokenBucketStageV3,
	type GraphQLRateLimitHeaderScope,
	type TokenBucketCheckV3,
	type TokenBucketStageResultV3,
} from "./http/token-bucket-v3";
import { validateGraphQLTransportPayload } from "./http/graphql-request";
import { runHealthChecks } from "./http/health";
import { createShutdownHandler } from "./http/shutdown";
import { LIGHTWEIGHT_CORE_FIELDS } from "./graphql/root-field-policy";
import {
	extractGraphQLOperationName,
	RequestTiming,
	resolveRequestId,
} from "./http/request-timing";

const currentSeasonProvider = new CurrentSeasonProvider();
registerDatabasePoolMetrics(() => ({
	total: dbPool.totalCount,
	idle: dbPool.idleCount,
	waiting: dbPool.waitingCount,
}));
assertGraphQLRateLimitModeCanStart(env.GRAPHQL_RATE_LIMIT_MODE, productionGraphQLRateLimitPolicy);
if (env.GRAPHQL_RATE_LIMIT_MODE === "shadow-v4" || env.GRAPHQL_RATE_LIMIT_MODE === "enforce-v4") {
	assertGraphQLRateLimitV4ModeCanStart(
		env.GRAPHQL_RATE_LIMIT_MODE,
		productionGraphQLRateLimitPolicyV4
	);
}
const isGraphQLV4Mode =
	env.GRAPHQL_RATE_LIMIT_MODE === "shadow-v4" || env.GRAPHQL_RATE_LIMIT_MODE === "enforce-v4";
const isGraphQLRateLimitShadowMode =
	env.GRAPHQL_RATE_LIMIT_MODE === "shadow-v3" || env.GRAPHQL_RATE_LIMIT_MODE === "shadow-v4";
const isGraphQLRateLimitEnforceMode =
	env.GRAPHQL_RATE_LIMIT_MODE === "enforce-v3" || env.GRAPHQL_RATE_LIMIT_MODE === "enforce-v4";
const activeGraphQLRateLimitPolicy = isGraphQLV4Mode
	? productionGraphQLRateLimitPolicyV4
	: productionGraphQLRateLimitPolicy;
const graphQLRateLimitConfig: GraphQLRateLimitConfig = {
	windowSeconds: productionGraphQLRateLimitPolicy.legacyV2.windowSeconds,
	globalAdmission: productionGraphQLRateLimitPolicy.legacyV2.globalRequest,
	sharedPublic: productionGraphQLRateLimitPolicy.legacyV2.sharedPublicWeighted,
	browserIngress: env.GRAPHQL_BROWSER_INGRESS_RATE_LIMIT,
	authenticated: env.GRAPHQL_AUTHENTICATED_RATE_LIMIT,
	anonymous: env.GRAPHQL_ANONYMOUS_RATE_LIMIT,
};

const graphQLVersionedPreAuthRateLimitChecks = (
	ingress: GraphQLIngress
): readonly TokenBucketCheckV3[] =>
	isGraphQLV4Mode
		? graphQLV4PreAuthRateLimitChecks(ingress, productionGraphQLRateLimitPolicyV4)
		: graphQLV3PreAuthRateLimitChecks(ingress, productionGraphQLRateLimitPolicy);

const graphQLVersionedEarlyFailureRateLimitChecks = (): readonly TokenBucketCheckV3[] =>
	isGraphQLV4Mode
		? graphQLV4EarlyFailureRateLimitChecks(productionGraphQLRateLimitPolicyV4)
		: graphQLV3EarlyFailureRateLimitChecks(productionGraphQLRateLimitPolicy);

const graphQLVersionedPrincipalAdmission = ({
	ingress,
	principal,
	cost,
}: {
	ingress: GraphQLIngress;
	principal: Principal | null;
	cost: number;
}) =>
	isGraphQLV4Mode
		? graphQLV4PrincipalAdmission({
				ingress,
				principal,
				cost,
				policy: productionGraphQLRateLimitPolicyV4,
			})
		: graphQLV3PrincipalAdmission({
				ingress,
				principal,
				cost,
				policy: productionGraphQLRateLimitPolicy,
			});

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
		"Access-Control-Expose-Headers":
			"X-Request-Id, Retry-After, X-RateLimit-Policy, X-RateLimit-Scope, X-RateLimit-Workload, X-RateLimit-Shadow-Outcome, X-RateLimit-Shadow-Scope",
		"Access-Control-Max-Age": "86400",
	};

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

type GraphQLRateLimitStageExecution = {
	readonly response: Response | null;
	readonly legacyDecision?: RateLimitBatchResult;
	readonly v3Decision?: TokenBucketStageResultV3;
};

type GraphQLMetricResult =
	"ok" | "rate_limited" | "graphql_error" | "client_error" | "server_error";

const graphQLMetricResult = (response: Response, outcome: string): GraphQLMetricResult => {
	if (response.status === 429) return "rate_limited";
	if (outcome === "graphql_error") return "graphql_error";
	if (response.status >= 500) return "server_error";
	if (response.status >= 400) return "client_error";
	return "ok";
};

const legacyDecisionScope = (
	checks: Parameters<typeof checkRateLimits>[1],
	decision: RateLimitBatchResult
): GraphQLRateLimitHeaderScope => {
	const deniedCheck = checks[decision.deniedCheckIndex ?? 0];
	if (decision.deniedCheckIndex === 0 && checks.length > 1) return "global";
	return deniedCheck?.scope.includes("shared-public") ? "workload" : "client";
};

const checkLegacyGraphQLRateLimits = async ({
	checks,
	corsHeaders,
}: {
	checks: Parameters<typeof checkRateLimits>[1];
	corsHeaders: Record<string, string>;
}): Promise<{ response: Response | null; decision?: RateLimitBatchResult }> => {
	let decision: RateLimitBatchResult;
	try {
		decision = await checkRateLimits(getRateLimitRedis(), checks);
	} catch (error) {
		const storageScope = checks[0]?.scope ?? "graphql-ingress-v2";
		metrics.graphqlRateLimitDecisions.labels(storageScope, "storage_unavailable").inc();
		try {
			const fallback = handleRateLimitStorageFailure({
				error,
				failClosed: true,
				scope: storageScope,
				logger,
			});
			decision = { ...fallback };
		} catch {
			return {
				response: jsonError(
					503,
					"RATE_LIMIT_STORAGE_UNAVAILABLE",
					"Request safety checks are temporarily unavailable",
					corsHeaders
				),
			};
		}
	}

	if (!decision.allowed) {
		metrics.graphqlRateLimitDecisions
			.labels(decision.deniedScope ?? "graphql-admission", "limited")
			.inc();
		const scope = legacyDecisionScope(checks, decision);
		return {
			decision,
			response: jsonError(429, "RATE_LIMITED", "Too many requests", corsHeaders, {
				"Retry-After": String(decision.retryAfterSeconds),
				"X-RateLimit-Policy": "graphql-v2",
				"X-RateLimit-Scope": scope,
			}),
		};
	}

	for (const scope of new Set(checks.map((check) => check.scope))) {
		metrics.graphqlRateLimitDecisions.labels(scope, "allowed").inc();
	}
	return { decision, response: null };
};

const checkV3GraphQLRateLimits = async ({
	checks,
	corsHeaders,
	enforce,
	rateLimitWorkload,
}: {
	checks: readonly TokenBucketCheckV3[];
	corsHeaders: Record<string, string>;
	enforce: boolean;
	rateLimitWorkload?: string;
}): Promise<{ response: Response | null; decision?: TokenBucketStageResultV3 }> => {
	try {
		const decision = await checkTokenBucketStageV3(getRateLimitRedis(), checks);
		if (!decision.allowed && enforce) {
			return {
				decision,
				response: jsonError(429, "RATE_LIMITED", "Too many requests", corsHeaders, {
					"Retry-After": String(decision.retryAfterSeconds),
					"X-RateLimit-Policy": activeGraphQLRateLimitPolicy.policyVersion,
					"X-RateLimit-Scope": decision.deniedScope ?? "client",
					...(decision.deniedScope === "workload" && rateLimitWorkload
						? { "X-RateLimit-Workload": rateLimitWorkload }
						: {}),
				}),
			};
		}
		return { decision, response: null };
	} catch (error) {
		const scope = checks[0]?.id ?? "graphql-v3";
		try {
			handleRateLimitStorageFailure({
				error,
				failClosed: enforce,
				scope,
				logger,
			});
			return { response: null };
		} catch {
			return {
				response: jsonError(
					503,
					"RATE_LIMIT_STORAGE_UNAVAILABLE",
					"Request safety checks are temporarily unavailable",
					corsHeaders
				),
			};
		}
	}
};

const runGraphQLRateLimitStage = async ({
	legacyChecks,
	v3Checks,
	corsHeaders,
	shadowSkipLegacy = false,
	rateLimitWorkload,
}: {
	legacyChecks: Parameters<typeof checkRateLimits>[1];
	v3Checks: readonly TokenBucketCheckV3[];
	corsHeaders: Record<string, string>;
	shadowSkipLegacy?: boolean;
	rateLimitWorkload?: string;
}): Promise<GraphQLRateLimitStageExecution> => {
	if (env.GRAPHQL_RATE_LIMIT_MODE === "legacy") {
		const legacy = await checkLegacyGraphQLRateLimits({ checks: legacyChecks, corsHeaders });
		return { response: legacy.response, legacyDecision: legacy.decision };
	}
	if (isGraphQLRateLimitShadowMode) {
		const v3Promise: Promise<{
			response: Response | null;
			decision?: TokenBucketStageResultV3;
		}> =
			v3Checks.length > 0
				? checkV3GraphQLRateLimits({
						checks: v3Checks,
						corsHeaders,
						enforce: false,
						rateLimitWorkload,
					})
				: Promise.resolve({ response: null });
		const legacyPromise: Promise<{
			response: Response | null;
			decision?: RateLimitBatchResult;
		}> = shadowSkipLegacy
			? Promise.resolve({ response: null })
			: checkLegacyGraphQLRateLimits({ checks: legacyChecks, corsHeaders });
		const [legacy, v3] = await Promise.all([legacyPromise, v3Promise]);
		return {
			response: legacy.response,
			legacyDecision: legacy.decision,
			v3Decision: v3.decision,
		};
	}
	if (v3Checks.length === 0) return { response: null };
	const v3 = await checkV3GraphQLRateLimits({
		checks: v3Checks,
		corsHeaders,
		enforce: true,
		rateLimitWorkload,
	});
	return { response: v3.response, v3Decision: v3.decision };
};

const logV3RateLimitDecision = ({
	requestId,
	operation,
	rootFields,
	ingress,
	stage,
	audience,
	decision,
}: {
	requestId: string;
	operation: string;
	rootFields: readonly string[];
	ingress: GraphQLIngress;
	stage: "pre-auth" | "weighted";
	audience?: string;
	decision: TokenBucketStageResultV3;
}): void => {
	const selected =
		decision.details.find((detail) => detail.id === decision.deniedBucketId) ??
		decision.details.at(-1);
	logger.info(
		{
			requestId,
			operation,
			rootFields,
			trafficClass: ingress.trafficClass,
			workload: ingress.workload,
			stage,
			scope: decision.deniedScope ?? selected?.scope ?? "client",
			bucket: selected?.id ?? "unknown",
			cost: selected?.cost ?? 1,
			audience,
			burst: selected?.burst ?? 0,
			refill: selected?.refillPerSecond ?? 0,
			remaining: (selected?.remainingMilliTokens ?? 0) / 1000,
			retryAfter: decision.retryAfterSeconds,
			allowed: decision.allowed,
			outcome: isGraphQLRateLimitShadowMode
				? decision.allowed
					? "would_allow"
					: "would_deny"
				: decision.allowed
					? "allowed"
					: "denied",
			fingerprint: rateLimitFingerprint(ingress.subject),
			policy: activeGraphQLRateLimitPolicy.policyVersion,
		},
		`GraphQL ${activeGraphQLRateLimitPolicy.policyVersion.replace("graphql-", "")} rate-limit decision`
	);
};

const recordRequestRateLimitOutcome = async ({
	ingress,
	scope,
	outcome,
}: {
	ingress: GraphQLIngress;
	scope: GraphQLRateLimitHeaderScope;
	outcome: RateLimitAggregateOutcome;
}): Promise<void> =>
	recordRateLimitAggregate({
		redis: getRateLimitRedis(),
		trafficClass: ingress.trafficClass,
		workload: ingress.workload,
		scope,
		outcome,
		fingerprint: rateLimitFingerprint(ingress.subject),
		policyVersion: activeGraphQLRateLimitPolicy.policyVersion,
		logger,
	});

const terminalV3Outcome = (decision: TokenBucketStageResultV3): RateLimitAggregateOutcome =>
	isGraphQLRateLimitShadowMode
		? decision.allowed
			? "would_allow"
			: "would_deny"
		: decision.allowed
			? "allowed"
			: "denied";

const healthCheck = async (): Promise<{ ok: boolean; body: string }> => {
	const result = await runHealthChecks({
		redis: async () => {
			if ((await getRedis().ping()) !== "PONG")
				throw new Error("primary Redis did not answer PONG");
		},
		rateLimitRedis: async () => {
			if ((await getRateLimitRedis().ping()) !== "PONG") {
				throw new Error("rate-limit Redis did not answer PONG");
			}
		},
		postgres: async () => {
			await databaseHealthCheck();
		},
		season: async () => {
			currentSeasonProvider.get();
		},
	});
	if (!result.ok) logger.warn({ checks: result.checks }, "Health readiness degraded");
	return {
		ok: result.ok,
		body: JSON.stringify({ status: result.ok ? "ok" : "degraded", checks: result.checks }),
	};
};

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
				let trafficClass = "legacy";
				let workload = "public-other";
				let subjectFingerprint = "unresolved";
				let rootFields: readonly string[] = [];
				let rateLimitAudience = "unresolved";
				let fullCoreLoaded = false;
				let graphQLContext: GraphQLContext | undefined;
				let shadowLegacyPreAuthResponse: Response | null = null;
				let trustedIngress: GraphQLIngress | null = null;
				let v3AdmissionEvaluated = false;
				let terminalPreAuthV3Denial: TokenBucketStageResultV3 | null = null;
				let v3AggregateRecorded = false;
				let shadowRateLimitDecision: {
					outcome: "allow" | "deny";
					scope: GraphQLRateLimitHeaderScope;
				} | null = null;
				const captureShadowRateLimitDecision = (decision: TokenBucketStageResultV3): void => {
					if (!isGraphQLRateLimitShadowMode) return;
					if (shadowRateLimitDecision?.outcome === "deny") return;
					shadowRateLimitDecision = {
						outcome: decision.allowed ? "allow" : "deny",
						scope: decision.deniedScope ?? decision.details.at(-1)?.scope ?? "client",
					};
				};
				const recordTerminalRequestV3Outcome = async (
					ingress: GraphQLIngress,
					fallbackDecision: TokenBucketStageResultV3
				): Promise<void> => {
					if (v3AggregateRecorded) return;
					const terminalDecision = terminalPreAuthV3Denial ?? fallbackDecision;
					v3AggregateRecorded = true;
					await recordRequestRateLimitOutcome({
						ingress,
						scope:
							terminalDecision.deniedScope ?? terminalDecision.details.at(-1)?.scope ?? "client",
						outcome: terminalV3Outcome(terminalDecision),
					});
				};
				const finalizeGraphQLResponse = (response: Response, outcome: string): Response => {
					fullCoreLoaded =
						fullCoreLoaded ||
						graphQLContext?.fullCoreLoaded === true ||
						(graphQLContext?.requestScope as { fullCoreLoaded?: boolean } | undefined)
							?.fullCoreLoaded === true;
					const durationMs = requestTiming.elapsedMs();
					response.headers.set("X-Request-Id", requestId);
					if (trustedIngress && shadowRateLimitDecision) {
						response.headers.set("X-RateLimit-Shadow-Outcome", shadowRateLimitDecision.outcome);
						response.headers.set("X-RateLimit-Shadow-Scope", shadowRateLimitDecision.scope);
					}
					metrics.httpRequestDurationSeconds
						.labels(request.method, url.pathname, String(response.status))
						.observe(durationMs / 1000);
					metrics.graphqlRequestOutcomes.labels(graphQLMetricResult(response, outcome)).inc();
					logger.info(
						{
							requestId,
							operationName,
							ingressClass,
							trafficClass,
							workload,
							subjectFingerprint,
							rateLimitMode: env.GRAPHQL_RATE_LIMIT_MODE,
							rootFields,
							rateLimitAudience,
							outcome,
							method: request.method,
							path: url.pathname,
							status: response.status,
							durationMs: Number(durationMs.toFixed(2)),
							timings: requestTiming.snapshot(),
							fullCoreLoaded,
						},
						"GraphQL request timing"
					);
					return response;
				};
				const finalizePostPreAuthResponse = async (
					response: Response,
					outcome: string
				): Promise<Response> => {
					const ingressForFailure = trustedIngress;
					if (
						ingressForFailure &&
						!v3AdmissionEvaluated &&
						(isGraphQLRateLimitEnforceMode || isGraphQLRateLimitShadowMode)
					) {
						v3AdmissionEvaluated = true;
						const earlyAdmission = await requestTiming.measure("earlyFailureAdmission", () =>
							checkV3GraphQLRateLimits({
								checks: graphQLVersionedEarlyFailureRateLimitChecks(),
								corsHeaders,
								enforce: isGraphQLRateLimitEnforceMode,
								rateLimitWorkload: ingressForFailure.workload,
							})
						);
						if (earlyAdmission.decision) {
							captureShadowRateLimitDecision(earlyAdmission.decision);
							logV3RateLimitDecision({
								requestId,
								operation: operationName,
								rootFields,
								ingress: ingressForFailure,
								stage: "pre-auth",
								decision: earlyAdmission.decision,
							});
							await recordTerminalRequestV3Outcome(ingressForFailure, earlyAdmission.decision);
						}
						if (earlyAdmission.response) {
							return finalizeGraphQLResponse(
								earlyAdmission.response,
								"early_failure_admission_rejected"
							);
						}
					}
					return shadowLegacyPreAuthResponse
						? finalizeGraphQLResponse(shadowLegacyPreAuthResponse, "pre_auth_admission_rejected")
						: finalizeGraphQLResponse(response, outcome);
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
					trafficClass = ingress.trafficClass;
					workload = ingress.workload;
					subjectFingerprint = rateLimitFingerprint(ingress.subject);
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
					trustedIngress = ingress;

					const legacyPreAuthChecks = graphQLPreAuthRateLimitChecks(
						ingress,
						graphQLRateLimitConfig
					);
					const preAuthAdmission = await requestTiming.measure("preAuthAdmission", () =>
						runGraphQLRateLimitStage({
							legacyChecks: legacyPreAuthChecks,
							v3Checks: graphQLVersionedPreAuthRateLimitChecks(ingress),
							corsHeaders,
							rateLimitWorkload: ingress.workload,
						})
					);
					if (preAuthAdmission.v3Decision) {
						if (!preAuthAdmission.v3Decision.allowed) {
							terminalPreAuthV3Denial = preAuthAdmission.v3Decision;
						}
						captureShadowRateLimitDecision(preAuthAdmission.v3Decision);
						logV3RateLimitDecision({
							requestId,
							operation: operationName,
							rootFields,
							ingress,
							stage: "pre-auth",
							decision: preAuthAdmission.v3Decision,
						});
					}
					if (preAuthAdmission.response) {
						if (preAuthAdmission.legacyDecision && !preAuthAdmission.legacyDecision.allowed) {
							await recordRequestRateLimitOutcome({
								ingress,
								scope: legacyDecisionScope(legacyPreAuthChecks, preAuthAdmission.legacyDecision),
								outcome: "legacy_denied",
							});
						}
						if (
							isGraphQLRateLimitEnforceMode &&
							preAuthAdmission.v3Decision &&
							!preAuthAdmission.v3Decision.allowed
						) {
							await recordTerminalRequestV3Outcome(ingress, preAuthAdmission.v3Decision);
						}
						if (
							isGraphQLRateLimitShadowMode &&
							preAuthAdmission.legacyDecision &&
							!preAuthAdmission.legacyDecision.allowed
						) {
							// Preserve the v2 response, but continue through bounded parsing and
							// principal resolution so the v3 weighted decision is still observed.
							shadowLegacyPreAuthResponse = preAuthAdmission.response;
						} else {
							return finalizeGraphQLResponse(
								preAuthAdmission.response,
								"pre_auth_admission_rejected"
							);
						}
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
							return finalizePostPreAuthResponse(
								jsonError(
									400,
									"INVALID_GRAPHQL_REQUEST",
									"Request body must be valid JSON",
									corsHeaders
								),
								"invalid_json"
							);
						}
					}
					const transportFailure = validateGraphQLTransportPayload(parsedBody);
					if (transportFailure) {
						return finalizePostPreAuthResponse(
							jsonError(400, transportFailure.code, transportFailure.message, corsHeaders),
							"invalid_transport_payload"
						);
					}
					operationName = extractGraphQLOperationName(parsedBody);

					const limits = requestTiming.measureSync("requestLimits", () =>
						validateGraphQLRequestLimits(parsedBody, schema)
					);
					if (!limits.ok) {
						return finalizePostPreAuthResponse(
							jsonError(400, limits.code, limits.message, corsHeaders),
							"request_limits_rejected"
						);
					}
					rootFields = limits.rootFields;
					const { principal, user } = await requestTiming.measure("principal", () =>
						resolvePrincipalAndUser(request)
					);
					if (!principal && hasAuthenticationMaterial(request.headers)) {
						return finalizePostPreAuthResponse(
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
					const v3PrincipalAdmission = graphQLVersionedPrincipalAdmission({
						ingress,
						principal,
						cost: limits.rateLimitCostUnits,
					});
					if (env.GRAPHQL_RATE_LIMIT_MODE !== "legacy") {
						rateLimitAudience = v3PrincipalAdmission.audience;
					}
					const legacyPrincipalChecks = [principalAdmission.check];
					const principalAdmissionResult = await requestTiming.measure("principalAdmission", () =>
						runGraphQLRateLimitStage({
							legacyChecks: legacyPrincipalChecks,
							v3Checks: v3PrincipalAdmission.checks,
							corsHeaders,
							shadowSkipLegacy: shadowLegacyPreAuthResponse !== null,
							rateLimitWorkload: ingress.workload,
						})
					);
					if (env.GRAPHQL_RATE_LIMIT_MODE !== "legacy") {
						v3AdmissionEvaluated = true;
					}
					if (principalAdmissionResult.v3Decision) {
						captureShadowRateLimitDecision(principalAdmissionResult.v3Decision);
						logV3RateLimitDecision({
							requestId,
							operation: operationName,
							rootFields,
							ingress,
							stage: "weighted",
							audience: rateLimitAudience,
							decision: principalAdmissionResult.v3Decision,
						});
						await recordTerminalRequestV3Outcome(ingress, principalAdmissionResult.v3Decision);
					}
					if (shadowLegacyPreAuthResponse) {
						return finalizeGraphQLResponse(
							shadowLegacyPreAuthResponse,
							"pre_auth_admission_rejected"
						);
					}
					if (principalAdmissionResult.response) {
						if (
							principalAdmissionResult.legacyDecision &&
							!principalAdmissionResult.legacyDecision.allowed
						) {
							await recordRequestRateLimitOutcome({
								ingress,
								scope: legacyDecisionScope(
									legacyPrincipalChecks,
									principalAdmissionResult.legacyDecision
								),
								outcome: "legacy_denied",
							});
						}
						return finalizeGraphQLResponse(
							principalAdmissionResult.response,
							"principal_admission_rejected"
						);
					}
					if (principalAdmissionResult.legacyDecision?.allowed) {
						await recordRequestRateLimitOutcome({
							ingress,
							scope: principalAdmission.audience === "shared_public" ? "workload" : "client",
							outcome: "legacy_allowed",
						});
					}

					const currentSeason = currentSeasonProvider.get();
					const data = new ReadModelClient(database, currentSeason);
					const requestScope = {};
					const authorizedTournamentMemberships = new Set<number>();
					const authorization = await requestTiming.measure("authorization", () =>
						authorizeGraphQLRequest({
							body: parsedBody,
							principal,
							data,
							logger,
							requestScope,
							authorizedTournamentMemberships,
						})
					);
					if (!authorization.ok) {
						return finalizeGraphQLResponse(
							graphQLErrorResponse(authorization, corsHeaders),
							"authorization_rejected"
						);
					}

					graphQLContext = {
						data,
						database,
						currentSeason,
						// Only refresh lifecycle for the season pinned when this request
						// constructed its read-model client and authorization scope.
						refreshCurrentSeason: () =>
							currentSeasonProvider.refresh(database, 5_000, currentSeason),
						redis: getRedis(),
						logger,
						requestId,
						operationName,
						requestTiming,
						requestScope,
						authorizedTournamentMemberships,
						principal: principal ?? undefined,
						user: user ?? undefined,
					};
					const lightweightCoreRead =
						limits.shape === "query" &&
						limits.rootFields.length > 0 &&
						limits.rootFields.every((field) => LIGHTWEIGHT_CORE_FIELDS.has(field));
					if (!lightweightCoreRead) {
						fullCoreLoaded = true;
						graphQLContext.fullCoreLoaded = true;
						try {
							graphQLContext.dataRevision = await requestTiming.measure("publication", async () =>
								coreDatasetRevision(await getCoreDataSnapshot(graphQLContext!))
							);
						} catch (error) {
							logger.error({ err: error }, "Data publication authority is unavailable");
							return finalizePostPreAuthResponse(
								jsonError(
									503,
									"DATA_PUBLICATION_UNAVAILABLE",
									"Data publication is temporarily unavailable",
									corsHeaders
								),
								"publication_unavailable"
							);
						}
					} else {
						graphQLContext.fullCoreLoaded = false;
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
							context: async () => graphQLContext!,
						})
					);
					// A resolver may fall back from a lightweight root to the full Core
					// publication. Reflect the actual read path in the request log.
					fullCoreLoaded =
						fullCoreLoaded ||
						graphQLContext.fullCoreLoaded === true ||
						(graphQLContext.requestScope as { fullCoreLoaded?: boolean } | undefined)
							?.fullCoreLoaded === true;

					const stopResponseBuild = requestTiming.start("responseBuild");

					const responseHeaders: Record<string, string> = {};
					for (const [key, value] of httpGraphQLResponse.headers) {
						responseHeaders[key] = value;
					}

					let responseBody: string | ReadableStream;
					let graphQLResponseHasErrors = false;
					if (httpGraphQLResponse.body.kind === "complete") {
						responseBody = httpGraphQLResponse.body.string;
						try {
							const parsed = JSON.parse(responseBody) as { errors?: unknown };
							graphQLResponseHasErrors = Array.isArray(parsed.errors) && parsed.errors.length > 0;
						} catch {
							graphQLResponseHasErrors = true;
						}
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
						response.status >= 400 || graphQLResponseHasErrors ? "graphql_error" : "completed"
					);
				} catch (error) {
					if (error instanceof PayloadTooLargeError) {
						return finalizePostPreAuthResponse(
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
					return finalizePostPreAuthResponse(
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

	const shutdown = createShutdownHandler({
		server,
		stopApollo: () => apollo.stop(),
		closeRedis,
		closeDbPool,
		setExitCode: (code) => {
			process.exitCode = code;
		},
		exitProcess: (code) => {
			process.exit(code);
		},
		log: (error) => {
			if (error && typeof error === "object" && "signal" in error) {
				logger.info(error, "Shutting down");
			} else {
				logger.error({ err: error }, "Error during shutdown");
			}
		},
	});

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
