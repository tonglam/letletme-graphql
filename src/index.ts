import { ApolloServer, HeaderMap } from "@apollo/server";
import { timingSafeEqual } from "crypto";
import depthLimit from "graphql-depth-limit";
import { authorizeGraphQLRequest, graphQLErrorResponse } from "./graphql/authorization";
import type { GraphQLContext } from "./graphql/context";
import { validateGraphQLRequestLimits } from "./graphql/limits";
import { schema } from "./graphql/schema";
import { closeDbPool, dbPool } from "./infra/db-pool";
import { validateDeviceToken } from "./infra/device-auth";
import { env } from "./infra/env";
import { logger } from "./infra/logger";
import { classifyGraphQLIngress } from "./infra/ingress-context";
import { metrics, metricsResponse } from "./infra/metrics";
import {
	getPrincipalFromHeaders,
	principalToAuthUser,
	verifyWebsitePrincipal,
	type Principal,
} from "./infra/principal";
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
import {
	GRAPHQL_GLOBAL_ADMISSION_SUBJECT,
	graphQLAdmissionSubjects,
	graphQLIngressFailure,
	graphQLMethodFailure,
	graphQLUsesSharedPublicBudget,
	graphQLWeightedRateLimitSubject,
	shouldPrechargeResolvedPrincipal,
} from "./http/graphql-policy";

const GRAPHQL_RATE_LIMIT = 120;
const GRAPHQL_SERVICE_RATE_LIMIT = 600;
const SECURITY_OPERATION_RATE_LIMIT = 5;
const RATE_LIMIT_WINDOW_SECONDS = 60;
const GRAPHQL_GLOBAL_ADMISSION_RATE_LIMIT = 25 * RATE_LIMIT_WINDOW_SECONDS;

// These are the public-schema relations and RPCs used by the GraphQL roots in
// this release. Health must not report a green container when only `events`
// exists: a partially migrated Data schema would fail immediately on picker,
// live, or tournament reads.
const REQUIRED_DATA_RELATIONS: Record<string, readonly string[]> = {
	"public.events": [
		"id",
		"finished",
		"is_current",
		"is_next",
		"deadline_time",
		"deadline_time_epoch",
	],
	"public.players": ["id", "web_name", "team_id", "type", "price"],
	"public.teams": ["id", "name", "short_name"],
	"public.event_fixtures": ["id", "event_id", "team_h_id", "team_a_id"],
	"public.player_stats": ["element_id", "event_id", "total_points"],
	"public.player_market_snapshots": [
		"element_id",
		"snapshot_date",
		"captured_at",
		"selected_by_percent",
	],
	"public.fpl_player_fixture_stats": ["player_code", "event_id", "fixture_id", "team_id"],
	"public.event_lives": ["event_id", "element_id", "total_points"],
	"public.event_live_explains": ["event_id", "element_id"],
	"public.player_values": ["element_id", "value", "last_value", "change_date"],
	"public.entry_infos": ["id", "entry_name", "player_name"],
	"public.entry_event_results": [
		"entry_id",
		"event_id",
		"event_points",
		"event_rank",
		"overall_points",
		"overall_rank",
		"event_transfers",
		"event_transfers_cost",
		"event_net_points",
		"event_bench_points",
		"event_chip",
		"event_played_captain",
		"event_captain_points",
		"event_picks",
		"team_value",
		"bank",
	],
	"public.entry_event_picks": ["entry_id", "event_id"],
	"public.entry_event_transfers": ["entry_id", "event_id"],
	"public.entry_history_infos": ["entry_id", "season", "total_points", "overall_rank"],
	"public.entry_league_infos": ["entry_id", "league_id"],
	"public.tournament_infos": ["id", "league_id", "league_type"],
	"public.tournament_entries": ["tournament_id", "entry_id"],
	"public.v_tournament_event_result": ["tournament_id", "event_id", "entry_id"],
	"public.mv_tournament_event_snapshot": ["tournament_id", "event_id", "entry_id"],
	"public.league_event_results": ["league_id", "league_type", "event_id", "entry_id"],
	"public.tournament_battle_group_results": ["tournament_id", "event_id", "entry_id"],
	"public.tournament_selection_stats": ["tournament_id", "event_id", "element_id"],
	"public.public_league_trends_catalog": [
		"tournament_id",
		"display_name",
		"sort_order",
		"enabled",
		"published_at",
		"updated_at",
	],
};

const REQUIRED_DATA_FUNCTIONS = [
	"public.search_players_for_picker(text,integer,integer,integer,integer,integer,integer)",
	"public.get_captain_counts_for_entries(integer,text,integer,integer[])",
	"public.get_pick_aggregation(integer,integer[])",
	"public.get_transfer_aggregation(integer,integer[])",
] as const;

async function validateRuntimeDataContract(): Promise<boolean> {
	try {
		const relationNames = Object.keys(REQUIRED_DATA_RELATIONS);
		const relations = await dbPool.query<{ relation_name: string; relation_exists: boolean }>(
			`SELECT required.relation_name,
					to_regclass(required.relation_name) IS NOT NULL AS relation_exists
				 FROM unnest($1::text[]) AS required(relation_name)`,
			[relationNames]
		);
		const missingRelation = relations.rows.find((row) => !row.relation_exists);
		if (missingRelation) {
			logger.warn(
				{ relation: missingRelation.relation_name },
				"GraphQL data contract relation is missing"
			);
			return false;
		}

		const requiredColumns = relationNames.flatMap((relation) =>
			REQUIRED_DATA_RELATIONS[relation].map((column) => ({ relation, column }))
		);
		const columnRelations = requiredColumns.map(({ relation }) => relation);
		const columnNames = requiredColumns.map(({ column }) => column);
		const columns = await dbPool.query<{ relation_name: string; column_name: string }>(
			`SELECT required.relation_name, required.column_name
			 FROM unnest($1::text[], $2::text[]) AS required(relation_name, column_name)
			 JOIN pg_class relation ON relation.oid = to_regclass(required.relation_name)
			 JOIN pg_attribute attribute
			   ON attribute.attrelid = relation.oid
			  AND attribute.attname = required.column_name
			  AND attribute.attnum > 0
			  AND NOT attribute.attisdropped`,
			[columnRelations, columnNames]
		);
		const presentColumns = new Set(
			columns.rows.map((row) => `${row.relation_name}:${row.column_name}`)
		);
		const missingColumn = requiredColumns.find(
			({ relation, column }) => !presentColumns.has(`${relation}:${column}`)
		);
		if (missingColumn) {
			logger.warn(
				{ relation: missingColumn.relation, column: missingColumn.column },
				"GraphQL data contract column is missing"
			);
			return false;
		}

		const functions = await dbPool.query<{ signature: string; function_exists: boolean }>(
			`SELECT required.signature,
					to_regprocedure(required.signature) IS NOT NULL AS function_exists
				 FROM unnest($1::text[]) AS required(signature)`,
			[REQUIRED_DATA_FUNCTIONS]
		);
		const missingFunction = functions.rows.find((row) => !row.function_exists);
		if (missingFunction) {
			logger.warn(
				{ signature: missingFunction.signature },
				"GraphQL data contract function is missing"
			);
			return false;
		}
		return true;
	} catch (error) {
		logger.warn({ err: error }, "Failed to validate GraphQL data contract");
		return false;
	}
}

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
	request: Request,
	prevalidatedPrincipal: Principal | null = null
): Promise<{ principal: Principal | null; user: ReturnType<typeof principalToAuthUser> | null }> {
	let principal = prevalidatedPrincipal ?? (await getPrincipalFromHeaders(request.headers));
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

const enforceGraphQLRateLimit = async ({
	scope,
	keyScope = scope,
	subject,
	limit,
	cost = 1,
	message = "Too many requests",
	corsHeaders,
}: {
	scope: string;
	keyScope?: string;
	subject: string;
	limit: number;
	cost?: number;
	message?: string;
	corsHeaders: Record<string, string>;
}): Promise<Response | null> => {
	let decision;
	try {
		decision = await checkRateLimit(
			getRedis(),
			rateLimitKey(keyScope, subject),
			limit,
			RATE_LIMIT_WINDOW_SECONDS,
			cost
		);
	} catch (error) {
		metrics.graphqlRateLimitDecisions.labels(scope, "storage_unavailable").inc();
		try {
			decision = handleRateLimitStorageFailure({
				error,
				failClosed: true,
				scope,
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
		metrics.graphqlRateLimitDecisions.labels(scope, "limited").inc();
		return jsonError(429, "RATE_LIMITED", message, corsHeaders, {
			"Retry-After": String(decision.retryAfterSeconds),
		});
	}

	metrics.graphqlRateLimitDecisions.labels(scope, "allowed").inc();
	return null;
};

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

	checks.dataContract = (await validateRuntimeDataContract()) ? "ok" : "fail";

	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 2_000);
		try {
			const response = await fetch(
				`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/events?select=id&limit=1`,
				{
					headers: {
						apikey: env.SUPABASE_KEY,
						Authorization: `Bearer ${env.SUPABASE_KEY}`,
					},
					signal: controller.signal,
				}
			);
			checks.supabase = response.ok ? "ok" : "fail";
		} finally {
			clearTimeout(timeout);
		}
	} catch {
		checks.supabase = "fail";
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
	if (!env.GRAPHQL_SERVICE_TOKEN) {
		logger.warn("GRAPHQL_SERVICE_TOKEN is empty — trusted public server reads are disabled");
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
					const methodFailure = graphQLMethodFailure(request.method);
					if (methodFailure) {
						return jsonError(
							methodFailure.status,
							methodFailure.code,
							methodFailure.message,
							corsHeaders,
							{ Allow: "POST, OPTIONS" }
						);
					}

					const peerAddress = bunServer.requestIP(request)?.address;
					const clientIp = resolveClientIp(request.headers, peerAddress, env.TRUSTED_PROXY_HOPS);
					const globalAdmissionFailure = await enforceGraphQLRateLimit({
						scope: "graphql-global-admission",
						subject: GRAPHQL_GLOBAL_ADMISSION_SUBJECT,
						limit: GRAPHQL_GLOBAL_ADMISSION_RATE_LIMIT,
						corsHeaders,
					});
					if (globalAdmissionFailure) return globalAdmissionFailure;

					const ingress = classifyGraphQLIngress(request.headers);
					metrics.graphqlIngressRequests.labels(ingress.class).inc();
					const ingressFailure = graphQLIngressFailure(ingress, env.REQUIRE_SIGNED_WEB_INGRESS);
					if (ingressFailure) {
						return jsonError(
							ingressFailure.status,
							ingressFailure.code,
							ingressFailure.message,
							corsHeaders
						);
					}

					const compatibilityPrincipal =
						ingress.class === "unsigned_user_context"
							? verifyWebsitePrincipal(request.headers)
							: null;
					const admissionSubjects = graphQLAdmissionSubjects({
						headers: request.headers,
						ingress,
						principal: compatibilityPrincipal,
						fallbackSubject: clientIp,
					});

					let weightedRatePrecharged = false;
					if (admissionSubjects.ingress) {
						const ingressAdmissionFailure = await enforceGraphQLRateLimit({
							scope: admissionSubjects.prechargesWeightedBudget
								? "graphql-preauthorization"
								: "graphql-ingress-admission",
							keyScope: admissionSubjects.prechargesWeightedBudget ? "graphql" : undefined,
							subject: admissionSubjects.ingress,
							limit: ingress.class === "service" ? GRAPHQL_SERVICE_RATE_LIMIT : GRAPHQL_RATE_LIMIT,
							corsHeaders,
						});
						if (ingressAdmissionFailure) return ingressAdmissionFailure;
						weightedRatePrecharged = admissionSubjects.prechargesWeightedBudget;
					}

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

					const limits = validateGraphQLRequestLimits(parsedBody, schema);
					if (!limits.ok) {
						return jsonError(400, limits.code, limits.message, corsHeaders);
					}

					const { principal, user } = await resolvePrincipalAndUser(
						request,
						compatibilityPrincipal
					);
					const rateLimitSubject = graphQLWeightedRateLimitSubject({
						ingress,
						principal,
						fallbackSubject: clientIp,
					});
					const rateLimit = graphQLUsesSharedPublicBudget(ingress)
						? GRAPHQL_SERVICE_RATE_LIMIT
						: GRAPHQL_RATE_LIMIT;
					if (shouldPrechargeResolvedPrincipal(principal, weightedRatePrecharged)) {
						const principalAdmissionFailure = await enforceGraphQLRateLimit({
							scope: "graphql-preauthorization",
							keyScope: "graphql",
							subject: rateLimitSubject,
							limit: rateLimit,
							corsHeaders,
						});
						if (principalAdmissionFailure) return principalAdmissionFailure;
						weightedRatePrecharged = true;
					}
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

					const remainingWeightedCost =
						limits.rateLimitCostUnits - (weightedRatePrecharged ? 1 : 0);
					if (remainingWeightedCost > 0) {
						const weightedRateFailure = await enforceGraphQLRateLimit({
							scope: "graphql",
							subject: rateLimitSubject,
							limit: rateLimit,
							cost: remainingWeightedCost,
							corsHeaders,
						});
						if (weightedRateFailure) return weightedRateFailure;
					}

					if (limits.securityOperation) {
						// Anonymous compatibility calls share the normal public budget,
						// but legacy WeChat issuance needs a per-caller security bucket.
						const securityRateLimitSubject =
							ingress.class === "anonymous" ? `compat-anonymous:${clientIp}` : rateLimitSubject;
						const securityRateFailure = await enforceGraphQLRateLimit({
							scope: "legacy-session",
							subject: securityRateLimitSubject,
							limit: SECURITY_OPERATION_RATE_LIMIT,
							cost: limits.securityOperationCount,
							message: "Too many session attempts",
							corsHeaders,
						});
						if (securityRateFailure) return securityRateFailure;
					}
					const headers = new HeaderMap();
					request.headers.forEach((value, key) => {
						headers.set(key, value);
					});

					const httpGraphQLResponse = await apollo.executeHTTPGraphQLRequest({
						httpGraphQLRequest: {
							method: request.method.toUpperCase(),
							headers,
							body: parsedBody,
							search: "",
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
