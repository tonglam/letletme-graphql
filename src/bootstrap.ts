import { graphQLErrorResponse } from "./graphql/authorization";
import type { GraphQLContext } from "./graphql/context";
import { buildGraphQLRuntimeContext, resolvePrincipalAndUser } from "./graphql/runtime-context";
import { createGraphQLApolloServer, executeGraphQLRequest } from "./graphql/runtime-execution";
import { validateGraphQLRequestLimits } from "./graphql/limits";
import { schema } from "./graphql/schema";
import { validateDatabaseContract } from "./infra/database-contract";
import { database } from "./infra/database";
import { closeDbPool, dbPool } from "./infra/db-pool";
import { env } from "./infra/env";
import { logger } from "./infra/logger";
import { classifyGraphQLIngress, type GraphQLIngress } from "./infra/ingress-context";
import { metrics, metricsResponse, registerDatabasePoolMetrics } from "./infra/metrics";
import { rateLimitFingerprint } from "./infra/rate-limit-observability";
import { closeRedis, connectRedis } from "./infra/redis";
import { CurrentSeasonProvider } from "./infra/season";
import { PayloadTooLargeError, readRequestBody } from "./http/security";
import {
	graphQLIngressFailure,
	graphQLMethodFailure,
	hasAuthenticationMaterial,
} from "./http/graphql-policy";
import { graphQLPrincipalSubject } from "./http/graphql-policy-v3";
import type { TokenBucketStageResultV3 } from "./http/token-bucket-v3";
import { validateGraphQLTransportPayload } from "./http/graphql-request";
import { createShutdownHandler } from "./http/shutdown";
import {
	getCorsHeaders,
	graphQLMetricResult,
	jsonError,
	metricsTokenMatches,
} from "./http/runtime-http";
import { checkRuntimeReadiness } from "./http/runtime-readiness";
import {
	hasLivePointsV2Contract,
	isLivePointsHotPathOperation,
	LIVE_POINTS_CONTRACT_HEADER,
	LIVE_POINTS_CONTRACT_VALUE,
	requiresLivePointsV2Contract,
} from "./http/live-points-contract";
import {
	hasLiveMatchesV2Contract,
	LIVE_MATCHES_CONTRACT_HEADER,
	LIVE_MATCHES_CONTRACT_VALUE,
	requiresLiveMatchesV2Contract,
	isLiveMatchesHotPathOperation,
} from "./http/live-matches-contract";
import { GraphQLAdmissionOrder } from "./http/graphql-admission-order";
import {
	mergeShadowRateLimitDecision,
	selectTerminalRateLimitDecision,
	type ShadowRateLimitDecision,
} from "./http/graphql-admission-decision";
import {
	checkV3GraphQLRateLimits,
	graphQLVersionedEarlyFailureRateLimitChecks,
	graphQLVersionedPreAuthRateLimitChecks,
	graphQLVersionedPrincipalAdmission,
	isGraphQLRateLimitEnforceMode,
	isGraphQLRateLimitShadowMode,
	isShadowOnlyRateLimitDecision,
	logV3RateLimitDecision,
	recordRequestRateLimitOutcome,
	runGraphQLRateLimitStage,
	terminalV3Outcome,
} from "./http/graphql-admission-runtime";
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

export const startServer = async (): Promise<void> => {
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

	const apollo = createGraphQLApolloServer();

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

			if (url.pathname === "/health/live") {
				return new Response(
					JSON.stringify({
						status: "ok",
						contractVersion: "live-points-v2",
						deploySha: env.DEPLOY_SHA,
					}),
					{
						status: 200,
						headers: {
							"Content-Type": "application/json",
							...corsHeaders,
						},
					}
				);
			}

			if (url.pathname === "/health/ready") {
				const health = await checkRuntimeReadiness(currentSeasonProvider, false, true);
				return new Response(health.body, {
					status: health.ok ? 200 : 503,
					headers: {
						"Content-Type": "application/json",
						...corsHeaders,
					},
				});
			}

			if (url.pathname === "/health/hot") {
				const health = await checkRuntimeReadiness(currentSeasonProvider, false, false);
				return new Response(health.body, {
					status: health.ok ? 200 : 503,
					headers: {
						"Content-Type": "application/json",
						...corsHeaders,
					},
				});
			}

			if (url.pathname === "/health/deploy") {
				const health = await checkRuntimeReadiness(currentSeasonProvider, true, true);
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
				const admissionOrder = new GraphQLAdmissionOrder();
				const requestId = resolveRequestId(request.headers.get("X-Request-Id"));
				corsHeaders["X-Request-Id"] = requestId;
				let operationName = "anonymous";
				let ingressClass = "unclassified";
				let trafficClass = "untrusted";
				let workload = "public-other";
				let subjectFingerprint = "unresolved";
				let rootFields: readonly string[] = [];
				let rateLimitAudience = "unresolved";
				let fullCoreLoaded = false;
				let graphQLContext: GraphQLContext | undefined;
				let trustedIngress: GraphQLIngress | null = null;
				let v3AdmissionEvaluated = false;
				let terminalPreAuthV3Denial: TokenBucketStageResultV3 | null = null;
				let v3AggregateRecorded = false;
				let shadowRateLimitDecision: ShadowRateLimitDecision | null = null;
				const captureShadowRateLimitDecision = (decision: TokenBucketStageResultV3): void => {
					if (!isShadowOnlyRateLimitDecision(decision)) return;
					shadowRateLimitDecision = mergeShadowRateLimitDecision(shadowRateLimitDecision, decision);
				};
				const recordTerminalRequestV3Outcome = async (
					ingress: GraphQLIngress,
					fallbackDecision: TokenBucketStageResultV3
				): Promise<void> => {
					if (v3AggregateRecorded) return;
					const terminalDecision = selectTerminalRateLimitDecision(
						terminalPreAuthV3Denial,
						fallbackDecision
					);
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
					return finalizeGraphQLResponse(response, outcome);
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

					admissionOrder.enter("pre-auth");
					const preAuthAdmission = await requestTiming.measure("preAuthAdmission", () =>
						runGraphQLRateLimitStage({
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
						if (
							isGraphQLRateLimitEnforceMode &&
							preAuthAdmission.v3Decision &&
							!preAuthAdmission.v3Decision.allowed
						) {
							await recordTerminalRequestV3Outcome(ingress, preAuthAdmission.v3Decision);
						}
						return finalizeGraphQLResponse(
							preAuthAdmission.response,
							"pre_auth_admission_rejected"
						);
					}

					admissionOrder.enter("body-read");
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
					admissionOrder.enter("transport");
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
					const livePointsHotPath = isLivePointsHotPathOperation(rootFields);
					const liveMatchesHotPath = isLiveMatchesHotPathOperation(rootFields);
					const requiresLivePointsContract = requiresLivePointsV2Contract(rootFields);
					const requiresLiveMatchesContract = requiresLiveMatchesV2Contract(rootFields);
					if (requiresLivePointsContract && requiresLiveMatchesContract) {
						const response = jsonError(
							400,
							"MIXED_LIVE_CONTRACTS",
							"Live Points and Live Matches must use separate GraphQL operations",
							corsHeaders
						);
						return finalizePostPreAuthResponse(response, "mixed_live_contracts_rejected");
					}
					if (requiresLivePointsContract && !hasLivePointsV2Contract(request.headers)) {
						const response = jsonError(
							426,
							"CLIENT_UPGRADE_REQUIRED",
							"Live Points requires the live-points-v2 client contract",
							corsHeaders,
							{ [LIVE_POINTS_CONTRACT_HEADER]: LIVE_POINTS_CONTRACT_VALUE }
						);
						return finalizePostPreAuthResponse(response, "live_points_contract_rejected");
					}
					if (requiresLiveMatchesContract && !hasLiveMatchesV2Contract(request.headers)) {
						const response = jsonError(
							426,
							"CLIENT_UPGRADE_REQUIRED",
							"Live Matches requires the live-matches-v2 client contract",
							corsHeaders,
							{ [LIVE_MATCHES_CONTRACT_HEADER]: LIVE_MATCHES_CONTRACT_VALUE }
						);
						return finalizePostPreAuthResponse(response, "live_matches_contract_rejected");
					}
					admissionOrder.enter("principal");
					const { principal, user } = await requestTiming.measure("principal", () =>
						resolvePrincipalAndUser(request)
					);
					admissionOrder.enter("authentication");
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

					admissionOrder.enter("weighted");
					const v3PrincipalAdmission = graphQLVersionedPrincipalAdmission({
						ingress,
						principal,
						cost: limits.rateLimitCostUnits,
					});
					rateLimitAudience = v3PrincipalAdmission.audience;
					const principalAdmissionResult = await requestTiming.measure("principalAdmission", () =>
						runGraphQLRateLimitStage({
							v3Checks: v3PrincipalAdmission.checks,
							corsHeaders,
							rateLimitWorkload: ingress.workload,
						})
					);
					v3AdmissionEvaluated = true;
					if (principalAdmissionResult.v3Decision) {
						captureShadowRateLimitDecision(principalAdmissionResult.v3Decision);
						logV3RateLimitDecision({
							requestId,
							operation: operationName,
							rootFields,
							ingress,
							stage: "weighted",
							audience: rateLimitAudience,
							identitySubject: principal ? graphQLPrincipalSubject(principal) : ingress.subject,
							decision: principalAdmissionResult.v3Decision,
						});
						await recordTerminalRequestV3Outcome(ingress, principalAdmissionResult.v3Decision);
					}
					if (principalAdmissionResult.response) {
						return finalizeGraphQLResponse(
							principalAdmissionResult.response,
							"principal_admission_rejected"
						);
					}
					admissionOrder.enter("authorization");
					const contextResult = await buildGraphQLRuntimeContext({
						currentSeasonProvider,
						parsedBody,
						principal,
						user,
						requestTiming,
						requestId,
						operationName,
						limits,
						readOnlyHotPath: livePointsHotPath || liveMatchesHotPath,
					});
					if (!contextResult.ok) {
						fullCoreLoaded = contextResult.fullCoreLoaded;
						const { failure } = contextResult;
						if (failure.kind === "authorization") {
							return finalizeGraphQLResponse(
								graphQLErrorResponse(failure.authorization, corsHeaders, requestId),
								failure.outcome
							);
						}
						return finalizePostPreAuthResponse(
							jsonError(failure.status, failure.code, failure.message, corsHeaders),
							failure.outcome
						);
					}
					graphQLContext = contextResult.context;
					fullCoreLoaded = contextResult.fullCoreLoaded;
					const execution = await executeGraphQLRequest({
						apollo,
						request,
						parsedBody,
						context: graphQLContext,
						requestTiming,
						requestId,
						corsHeaders,
					});
					// A resolver may fall back from a lightweight root to the full Core
					// publication. Reflect the actual read path in the request log.
					fullCoreLoaded =
						fullCoreLoaded ||
						graphQLContext.fullCoreLoaded === true ||
						(graphQLContext.requestScope as { fullCoreLoaded?: boolean } | undefined)
							?.fullCoreLoaded === true;
					return finalizeGraphQLResponse(
						execution.response,
						execution.response.status >= 400 || execution.hasErrors ? "graphql_error" : "completed"
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
								errors: [
									{
										message: "Internal server error",
										extensions: { code: "INTERNAL_SERVER_ERROR", requestId },
									},
								],
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
