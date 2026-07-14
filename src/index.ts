import { ApolloServer, HeaderMap } from "@apollo/server";
import { timingSafeEqual } from "crypto";
import depthLimit from "graphql-depth-limit";
import {
	authorizeGraphQLRequest,
	graphQLErrorResponse,
} from "./graphql/authorization";
import type { GraphQLContext } from "./graphql/context";
import { schema } from "./graphql/schema";
import { auth, getFplEntryIdForUser, getUserFromSession } from "./infra/auth";
import { closeDbPool, dbPool } from "./infra/db-pool";
import { authenticateDevice, validateDeviceToken } from "./infra/device-auth";
import { env } from "./infra/env";
import { logger } from "./infra/logger";
import { metrics, metricsResponse } from "./infra/metrics";
import {
	getPrincipalFromHeaders,
	principalToAuthUser,
	type Principal,
} from "./infra/principal";
import { closeRedis, connectRedis, getRedis } from "./infra/redis";
import { supabase } from "./infra/supabase";

const DEVICE_AUTH_RATE_LIMIT = 30;
const DEVICE_AUTH_WINDOW_SECONDS = 60;

function getCorsHeaders(origin: string | null): Record<string, string> {
	const allowedOrigin =
		env.CORS_ORIGIN === "*" ? origin || "*" : env.CORS_ORIGIN;

	const headers: Record<string, string> = {
		"Access-Control-Allow-Origin": allowedOrigin,
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Allow-Headers":
			"Content-Type, Authorization, X-User-Context, X-User-Context-Sig",
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
	return (
		expected.length === actual.length && timingSafeEqual(expected, actual)
	);
}

async function checkDeviceAuthRateLimit(
	ip: string,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
	const redis = getRedis();
	const key = `rate:device-auth:${ip}`;
	const count = await redis.incr(key);
	if (count === 1) {
		await redis.expire(key, DEVICE_AUTH_WINDOW_SECONDS);
	}
	if (count > DEVICE_AUTH_RATE_LIMIT) {
		const ttl = await redis.ttl(key);
		return {
			allowed: false,
			retryAfterSeconds: ttl > 0 ? ttl : DEVICE_AUTH_WINDOW_SECONDS,
		};
	}
	return { allowed: true, retryAfterSeconds: 0 };
}

async function resolvePrincipalAndUser(
	request: Request,
): Promise<{ principal: Principal | null; user: ReturnType<typeof principalToAuthUser> | null }> {
	let principal = await getPrincipalFromHeaders(request.headers);
	let user = principal ? principalToAuthUser(principal) : null;

	if (!principal) {
		const sessionUser = await getUserFromSession(request.headers);
		if (sessionUser) {
			const fplEntryId = await getFplEntryIdForUser(sessionUser.id);
			principal = {
				userId: sessionUser.id,
				source: "website",
				provider: "better_auth",
				fplEntryId,
			};
			user = { ...sessionUser, fplEntryId };
		}
	}

	if (!principal) {
		const authHeader = request.headers.get("Authorization");
		const token = authHeader?.match(/^bearer\s+(.+)$/i)?.[1]?.trim();
		if (token) {
			const deviceUser = await validateDeviceToken(token);
			if (deviceUser) {
				const fplEntryId =
					deviceUser.fplEntryId ??
					(await getFplEntryIdForUser(deviceUser.id));
				principal = {
					userId: deviceUser.id,
					source: "device",
					provider: "device",
					fplEntryId,
				};
				user = { ...deviceUser, fplEntryId };
			}
		}
	}

	return { principal, user };
}

async function healthCheck(): Promise<{ ok: boolean; body: string }> {
	const checks: Record<string, string> = {};

	try {
		const pong = await getRedis().ping();
		checks.redis = pong === "PONG" ? "ok" : "fail";
	} catch {
		checks.redis = "fail";
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
		logger.warn(
			"BACKEND_PROXY_SECRET is empty — website X-User-Context principals are disabled",
		);
	}

	const apollo = new ApolloServer<GraphQLContext>({
		schema,
		introspection: !env.isProduction,
		validationRules: [depthLimit(10)],
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

			if (url.pathname.startsWith("/api/auth")) {
				return auth.handler(request);
			}

			if (url.pathname === "/api/device/auth" && request.method === "POST") {
				try {
					const forwarded = request.headers.get("x-forwarded-for");
					const ip =
						forwarded?.split(",")[0]?.trim() ||
						request.headers.get("x-real-ip") ||
						"unknown";
					const rate = await checkDeviceAuthRateLimit(ip);
					if (!rate.allowed) {
						return new Response(
							JSON.stringify({ error: "Too many requests" }),
							{
								status: 429,
								headers: {
									"Content-Type": "application/json",
									"Retry-After": String(rate.retryAfterSeconds),
									...corsHeaders,
								},
							},
						);
					}

					const body = (await request.json()) as {
						device_id?: string;
						device_name?: string;
						device_os?: string;
					};
					const { device_id, device_name, device_os } = body;

					if (!device_id || typeof device_id !== "string") {
						return new Response(
							JSON.stringify({
								error: "device_id is required and must be a string",
							}),
							{
								status: 400,
								headers: {
									"Content-Type": "application/json",
									...corsHeaders,
								},
							},
						);
					}

					const result = await authenticateDevice(device_id, {
						name: device_name,
						os: device_os,
					});

					return new Response(JSON.stringify(result), {
						status: 200,
						headers: {
							"Content-Type": "application/json",
							...corsHeaders,
						},
					});
				} catch (error) {
					logger.error({ err: error }, "Device authentication failed");
					return new Response(
						JSON.stringify({ error: "Authentication failed" }),
						{
							status: 500,
							headers: {
								"Content-Type": "application/json",
								...corsHeaders,
							},
						},
					);
				}
			}

			if (url.pathname === "/graphql") {
				const start = performance.now();

				try {
					const body = await request.text();
					let parsedBody: unknown = undefined;
					if (body) {
						try {
							parsedBody = JSON.parse(body);
						} catch {
							return new Response(
								JSON.stringify({ errors: [{ message: "Invalid JSON" }] }),
								{
									status: 400,
									headers: {
										"Content-Type": "application/json",
										...corsHeaders,
									},
								},
							);
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
						"request",
					);

					return response;
				} catch (error) {
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
						},
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
	logger.info(
		{ url: `http://localhost:${env.PORT}/graphql` },
		"GraphQL endpoint ready",
	);
};

startServer().catch((error: unknown) => {
	logger.error({ err: error }, "Failed to start server");
	process.exit(1);
});

