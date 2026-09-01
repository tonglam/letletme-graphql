import {
	coreDatasetRevision,
	getCoreDataSnapshot,
	getCoreDatasetRevision,
} from "../infra/data-snapshot";
import { database } from "../infra/database";
import { logger } from "../infra/logger";
import { getPrincipalFromHeaders, principalToAuthUser, type Principal } from "../infra/principal";
import { ReadModelClient } from "../infra/read-model-client";
import { getRedis } from "../infra/redis";
import type { CurrentSeasonProvider } from "../infra/season";
import type { RequestTiming } from "../http/request-timing";
import { authorizeGraphQLRequest, type AuthorizationResult } from "./authorization";
import type { GraphQLContext } from "./context";
import type { GraphQLLimitResult } from "./limits";
import { LIGHTWEIGHT_CORE_FIELDS, REVISIONED_QUERY_CACHE_FIELDS } from "./root-field-policy";
import { schema } from "./schema";

type AcceptedGraphQLLimits = Extract<GraphQLLimitResult, { ok: true }>;
type AuthorizationFailure = Exclude<AuthorizationResult, { ok: true }>;

export type RuntimeContextFailure =
	| Readonly<{
			kind: "season";
			status: 503;
			code: "SEASON_AUTHORITY_UNAVAILABLE";
			message: string;
			outcome: "season_authority_unavailable";
	  }>
	| Readonly<{
			kind: "authorization";
			authorization: AuthorizationFailure;
			outcome: "authorization_rejected";
	  }>
	| Readonly<{
			kind: "publication";
			status: 503;
			code: "DEPENDENCY_UNAVAILABLE";
			message: string;
			outcome: "publication_unavailable";
	  }>;

export type RuntimeContextResult =
	| Readonly<{ ok: true; context: GraphQLContext; fullCoreLoaded: boolean }>
	| Readonly<{ ok: false; failure: RuntimeContextFailure; fullCoreLoaded: boolean }>;

export const resolvePrincipalAndUser = async (
	request: Request
): Promise<{
	principal: Principal | null;
	user: ReturnType<typeof principalToAuthUser> | null;
}> => {
	const principal = await getPrincipalFromHeaders(request.headers);
	return { principal, user: principal ? principalToAuthUser(principal) : null };
};

export const buildGraphQLRuntimeContext = async ({
	currentSeasonProvider,
	parsedBody,
	principal,
	user,
	requestTiming,
	requestId,
	operationName,
	limits,
	readOnlyHotPath = false,
}: {
	currentSeasonProvider: CurrentSeasonProvider;
	parsedBody: unknown;
	principal: Principal | null;
	user: ReturnType<typeof principalToAuthUser> | null;
	requestTiming: RequestTiming;
	requestId: string;
	operationName: string;
	limits: AcceptedGraphQLLimits;
	readOnlyHotPath?: boolean;
}): Promise<RuntimeContextResult> => {
	let currentSeason: GraphQLContext["currentSeason"];
	try {
		currentSeason = await requestTiming.measure("season", () =>
			readOnlyHotPath
				? Promise.resolve(currentSeasonProvider.get())
				: currentSeasonProvider.refresh(database, 5_000)
		);
	} catch (error) {
		if (readOnlyHotPath) {
			try {
				// The season identity was pinned at startup. During a PostgreSQL
				// incident, a V2 live request may continue against that identity;
				// the publication reader still fences every payload by season/event.
				currentSeason = currentSeasonProvider.get();
				logger.warn(
					{ err: error, requestId },
					"Season authority unavailable; serving Live Points with startup season LKG"
				);
			} catch {
				logger.warn({ err: error, requestId }, "Current season authority unavailable");
				return {
					ok: false,
					fullCoreLoaded: false,
					failure: {
						kind: "season",
						status: 503,
						code: "SEASON_AUTHORITY_UNAVAILABLE",
						message: "Current season metadata is temporarily unavailable",
						outcome: "season_authority_unavailable",
					},
				};
			}
		} else {
			logger.warn({ err: error, requestId }, "Current season authority unavailable");
			return {
				ok: false,
				fullCoreLoaded: false,
				failure: {
					kind: "season",
					status: 503,
					code: "SEASON_AUTHORITY_UNAVAILABLE",
					message: "Current season metadata is temporarily unavailable",
					outcome: "season_authority_unavailable",
				},
			};
		}
	}

	const data = new ReadModelClient(database, currentSeason);
	const requestScope = {};
	const authorizedTournamentMemberships = new Set<number>();
	const authorization = await requestTiming.measure("authorization", () =>
		authorizeGraphQLRequest({
			body: parsedBody,
			principal,
			data,
			logger,
			schema,
			requestScope,
			authorizedTournamentMemberships,
		})
	);
	if (!authorization.ok) {
		return {
			ok: false,
			fullCoreLoaded: false,
			failure: { kind: "authorization", authorization, outcome: "authorization_rejected" },
		};
	}

	const context: GraphQLContext = {
		data,
		database,
		currentSeason,
		refreshCurrentSeason: () => currentSeasonProvider.refresh(database, 5_000, currentSeason),
		redis: getRedis(),
		logger,
		requestId,
		operationName,
		deprecatedSymbols: limits.deprecatedSymbols,
		deprecatedSymbolOwners: limits.deprecatedSymbolOwners,
		deprecatedSymbolGlobalSymbols: limits.deprecatedSymbolGlobalSymbols,
		requestTiming,
		requestScope,
		authorizedTournamentMemberships,
		principal: principal ?? undefined,
		user: user ?? undefined,
	};

	// Live Points V2 is a Redis-first projection.  Do not make the request wait
	// for the full Core publication (or PostgreSQL) before the resolver can
	// read its same-event current/previous/LKG data.  The V2 resolvers load only
	// the identity slice they need and retain their own exact-event fallback.
	if (readOnlyHotPath) {
		context.fullCoreLoaded = false;
		return { ok: true, context, fullCoreLoaded: false };
	}

	const lightweightCoreRead =
		limits.shape === "query" &&
		limits.rootFields.length > 0 &&
		limits.rootFields.every((field) => LIGHTWEIGHT_CORE_FIELDS.has(field));
	if (lightweightCoreRead) {
		context.fullCoreLoaded = false;
		if (limits.rootFields.some((field) => REVISIONED_QUERY_CACHE_FIELDS.has(field))) {
			try {
				// Review roots remain lightweight (no Core payload transfer), but
				// their revisioned query cache must be fenced by the current Core
				// publication identity. Read the manifest only on the hot path.
				context.dataRevision = await requestTiming.measure("publication", () =>
					getCoreDatasetRevision(context)
				);
			} catch (error) {
				logger.error({ err: error, requestId }, "Data publication authority is unavailable");
				return {
					ok: false,
					fullCoreLoaded: false,
					failure: {
						kind: "publication",
						status: 503,
						code: "DEPENDENCY_UNAVAILABLE",
						message: "Data publication is temporarily unavailable",
						outcome: "publication_unavailable",
					},
				};
			}
		}
		return { ok: true, context, fullCoreLoaded: false };
	}

	context.fullCoreLoaded = true;
	try {
		context.dataRevision = await requestTiming.measure("publication", async () =>
			coreDatasetRevision(await getCoreDataSnapshot(context))
		);
	} catch (error) {
		logger.error({ err: error, requestId }, "Data publication authority is unavailable");
		return {
			ok: false,
			fullCoreLoaded: true,
			failure: {
				kind: "publication",
				status: 503,
				code: "DEPENDENCY_UNAVAILABLE",
				message: "Data publication is temporarily unavailable",
				outcome: "publication_unavailable",
			},
		};
	}
	return { ok: true, context, fullCoreLoaded: true };
};
