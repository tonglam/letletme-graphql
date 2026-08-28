import {
	analyzeGraphQLOperation,
	type GraphQLRequestPayload,
	type GraphQLRootField,
} from "./operation-ast";
import type { Logger } from "../infra/logger";
import type { Principal } from "../infra/principal";
import type { ReadModelClient } from "../infra/read-model-client";
import {
	getConditionalRootFieldConditions,
	getRootFieldPolicy,
	ROOT_FIELD_POLICIES,
	type RootFieldConditionalAccess,
	type RootFieldPolicy,
	type RootFieldAccess,
} from "./root-field-policy";
export { isGraphQLRootFieldClassified } from "./root-field-policy";

type RootField = GraphQLRootField;

type AuthorizationInput = {
	body: unknown;
	principal?: Principal | null;
	data: ReadModelClient;
	logger: Logger;
	requestScope?: object;
	authorizedTournamentMemberships?: Set<number>;
};

export type AuthorizationResult =
	| { ok: true }
	| {
			ok: false;
			status: 401 | 403;
			code: "UNAUTHENTICATED" | "VIEWER_ENTRY_REQUIRED" | "FORBIDDEN";
			message: string;
	  };

const viewerEntryArgFields = new Map(
	[...ROOT_FIELD_POLICIES]
		.filter(
			([, value]) =>
				value.ownEntryArg ?? (value.access === "viewerEntryArg" ? value.arg : undefined)
		)
		.map(([key, value]) => [key, value.ownEntryArg ?? value.arg!] as const)
);
const protectedFields = new Set(
	[...ROOT_FIELD_POLICIES].filter(([, value]) => value.access !== "public").map(([key]) => key)
);

const getRequestPayloads = (body: unknown): GraphQLRequestPayload[] => {
	if (Array.isArray(body)) {
		return body as GraphQLRequestPayload[];
	}
	if (body && typeof body === "object") {
		return [body as GraphQLRequestPayload];
	}
	return [];
};

const asPositiveInt = (value: unknown): number | null =>
	typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;

const requirePrincipal = (principal?: Principal | null): AuthorizationResult =>
	principal
		? { ok: true }
		: {
				ok: false,
				status: 401,
				code: "UNAUTHENTICATED",
				message: "Authentication required",
			};

const hasVerifiedEntry = (principal: Principal): boolean =>
	Boolean(principal.fplEntryId && principal.fplEntryVerifiedAt);

export const viewerEntryIdForPrincipal = (principal: Principal): number | null => {
	if (
		typeof principal.viewerEntryId === "number" &&
		Number.isSafeInteger(principal.viewerEntryId) &&
		principal.viewerEntryId > 0
	) {
		return principal.viewerEntryId;
	}
	return hasVerifiedEntry(principal) ? principal.fplEntryId : null;
};

const hasPlatformAdminAccess = (principal: Principal): boolean =>
	principal.source === "website" && principal.platformAdmin === true && hasVerifiedEntry(principal);

const requireViewerEntry = (principal: Principal, entryId: number | null): AuthorizationResult => {
	if (!entryId || entryId !== viewerEntryIdForPrincipal(principal)) {
		return {
			ok: false,
			status: 403,
			code: "FORBIDDEN",
			message: "Requested entry is not selected by this viewer",
		};
	}
	return { ok: true };
};

export const authorizeViewerEntry = (
	principal: Principal | null | undefined
): AuthorizationResult => {
	const principalResult = requirePrincipal(principal);
	if (!principalResult.ok) return principalResult;
	if (!principal) return principalResult;
	if (!viewerEntryIdForPrincipal(principal)) {
		return {
			ok: false,
			status: 403,
			code: "VIEWER_ENTRY_REQUIRED",
			message: "A viewed FPL team is required",
		};
	}
	return { ok: true };
};

export const authorizeProtectedBinding = (
	principal: Principal | null | undefined
): AuthorizationResult => {
	const principalResult = requirePrincipal(principal);
	if (!principalResult.ok) return principalResult;
	if (!principal) return principalResult;
	if (!hasVerifiedEntry(principal)) {
		return {
			ok: false,
			status: 403,
			code: "FORBIDDEN",
			message: "A verified FPL binding is required",
		};
	}
	return { ok: true };
};

const hasTournamentMembership = async (
	dataClient: ReadModelClient,
	tournamentId: number,
	entryId: number,
	requestScope?: object,
	authorizedTournamentMemberships?: Set<number>
): Promise<boolean> => {
	const memo = requestScope ? tournamentAccessMemo(requestScope, "membership") : null;
	const memoKey = `${tournamentId}:${entryId}`;
	if (authorizedTournamentMemberships?.has(tournamentId)) return true;
	if (memo?.has(memoKey)) return memo.get(memoKey)!;
	const rosterMembership = await dataClient
		.read("competition.tournament_entries")
		.select("entry_id")
		.eq("tournament_id", tournamentId)
		.eq("entry_id", entryId)
		.limit(1);
	let value =
		!rosterMembership.error &&
		((rosterMembership.data as { entry_id: number }[] | null) ?? []).length > 0;
	if (!value) {
		const officialLeagueMembership = await dataClient
			.read("competition.entry_leagues_with_tournament")
			.select("tournament_id")
			.eq("tournament_id", tournamentId)
			.eq("entry_id", entryId)
			.limit(1);
		value =
			!officialLeagueMembership.error &&
			((officialLeagueMembership.data as { tournament_id: number | null }[] | null) ?? []).length >
				0;
	}
	memo?.set(memoKey, value);
	if (value) authorizedTournamentMemberships?.add(tournamentId);
	return value;
};

const tournamentAccessMemo = (
	scope: object,
	kind: "membership" | "admin"
): Map<string, boolean> => {
	let values = (scope as { tournamentAccess?: Record<string, Map<string, boolean>> })
		.tournamentAccess?.[kind];
	if (!values) {
		const holder = scope as { tournamentAccess?: Record<string, Map<string, boolean>> };
		holder.tournamentAccess ??= {};
		values = new Map();
		holder.tournamentAccess[kind] = values;
	}
	return values;
};

const hasLeagueMembership = async (
	dataClient: ReadModelClient,
	leagueId: number,
	entryId: number
): Promise<boolean> => {
	const { data, error } = await dataClient
		.read("competition.entry_leagues")
		.select("entry_id")
		.eq("league_id", leagueId)
		.eq("entry_id", entryId)
		.limit(1);
	if (error) return false;
	return ((data as { entry_id: number }[] | null) ?? []).length > 0;
};

const isTournamentAdmin = async (
	dataClient: ReadModelClient,
	tournamentId: number,
	entryId: number,
	scope?: object
): Promise<boolean> => {
	const memo = scope ? tournamentAccessMemo(scope, "admin") : null;
	const memoKey = `${tournamentId}:${entryId}`;
	if (memo?.has(memoKey)) return memo.get(memoKey)!;
	const { data, error } = await dataClient
		.read("competition.tournaments")
		.select("admin_entry_id")
		.eq("id", tournamentId)
		.eq("admin_entry_id", entryId)
		.limit(1);
	if (error) return false;
	const value = ((data as { admin_entry_id: number }[] | null) ?? []).length > 0;
	memo?.set(memoKey, value);
	return value;
};

const authorizeConditionalAccess = async ({
	condition,
	field,
	fieldPolicy,
	principal,
	dataClient,
	requestScope,
	authorizedTournamentMemberships,
}: {
	condition: RootFieldConditionalAccess;
	field: RootField;
	fieldPolicy: RootFieldPolicy | undefined;
	principal: Principal | null | undefined;
	dataClient: ReadModelClient;
	requestScope?: object;
	authorizedTournamentMemberships?: Set<number>;
}): Promise<AuthorizationResult> => {
	const access: RootFieldAccess = condition.access;
	switch (access) {
		case "public":
			return { ok: true };
		case "viewerEntry":
			return authorizeViewerEntry(principal);
		case "viewerEntryArg": {
			const identity = authorizeViewerEntry(principal);
			if (!identity.ok) return identity;
			if (!principal) return identity;
			return requireViewerEntry(principal, asPositiveInt(field.args[condition.argument]));
		}
		case "viewerTournamentMember": {
			const identity = authorizeViewerEntry(principal);
			if (!identity.ok) return identity;
			if (!principal) return identity;
			const tournamentId = asPositiveInt(field.args[condition.argument]);
			const viewerEntryId = viewerEntryIdForPrincipal(principal);
			if (!tournamentId || !viewerEntryId) {
				return {
					ok: false,
					status: 403,
					code: "FORBIDDEN",
					message: "User is not a member of this tournament",
				};
			}
			if (hasPlatformAdminAccess(principal)) return { ok: true };
			const isMember = await hasTournamentMembership(
				dataClient,
				tournamentId,
				viewerEntryId,
				requestScope,
				authorizedTournamentMemberships
			);
			const isRetainedAdmin =
				fieldPolicy?.retainedAdmin === true &&
				!isMember &&
				hasVerifiedEntry(principal) &&
				(await isTournamentAdmin(dataClient, tournamentId, principal.fplEntryId!, requestScope));
			if (isMember || isRetainedAdmin) return { ok: true };
			return {
				ok: false,
				status: 403,
				code: "FORBIDDEN",
				message: "User is not a member of this tournament",
			};
		}
		case "verifiedEntry":
			return authorizeProtectedBinding(principal);
		case "verifiedEntryArg": {
			const identity = authorizeProtectedBinding(principal);
			if (!identity.ok) return identity;
			if (!principal) return identity;
			const entryId = asPositiveInt(field.args[condition.argument]);
			if (entryId && entryId === principal.fplEntryId) return { ok: true };
			return {
				ok: false,
				status: 403,
				code: "FORBIDDEN",
				message: "Requested entry is not the verified administrator identity",
			};
		}
		case "tournamentAdmin": {
			const identity = authorizeProtectedBinding(principal);
			if (!identity.ok) return identity;
			if (!principal) return identity;
			const tournamentId = asPositiveInt(field.args[condition.argument]);
			if (
				tournamentId &&
				(hasPlatformAdminAccess(principal) ||
					(await isTournamentAdmin(dataClient, tournamentId, principal.fplEntryId!, requestScope)))
			) {
				return { ok: true };
			}
			return {
				ok: false,
				status: 403,
				code: "FORBIDDEN",
				message: "User is not the administrator of this tournament",
			};
		}
		case "leagueMember": {
			const identity = authorizeProtectedBinding(principal);
			if (!identity.ok) return identity;
			if (!principal) return identity;
			const leagueId = asPositiveInt(field.args[condition.argument]);
			if (
				leagueId &&
				(hasPlatformAdminAccess(principal) ||
					(await hasLeagueMembership(dataClient, leagueId, principal.fplEntryId!)))
			) {
				return { ok: true };
			}
			return {
				ok: false,
				status: 403,
				code: "FORBIDDEN",
				message: "User is not a member of this league",
			};
		}
		case "calcOwnEntries": {
			const identity = authorizeProtectedBinding(principal);
			if (!identity.ok) return identity;
			if (!principal) return identity;
			const entryIds = Array.isArray(field.args[condition.argument])
				? field.args[condition.argument]
				: [];
			if (
				Array.isArray(entryIds) &&
				entryIds.length > 0 &&
				entryIds.every((entryId) => entryId === principal.fplEntryId)
			) {
				return { ok: true };
			}
			return {
				ok: false,
				status: 403,
				code: "FORBIDDEN",
				message: "Requested entries are not bound to this user",
			};
		}
	}
};

const authorizeRootField = async (
	field: RootField,
	principal: Principal | null | undefined,
	dataClient: ReadModelClient,
	requestScope?: object,
	authorizedTournamentMemberships?: Set<number>
): Promise<AuthorizationResult> => {
	const fieldPolicy = getRootFieldPolicy(field.name);
	for (const condition of getConditionalRootFieldConditions(field.name, field.args)) {
		const result = await authorizeConditionalAccess({
			condition,
			field,
			fieldPolicy,
			principal,
			dataClient,
			requestScope,
			authorizedTournamentMemberships,
		});
		if (!result.ok) return result;
	}
	if (fieldPolicy?.access === "public") return { ok: true };
	if (!fieldPolicy || !protectedFields.has(field.name)) {
		return {
			ok: false,
			status: 403,
			code: "FORBIDDEN",
			message: "GraphQL operation has no authorization policy",
		};
	}

	const viewerAccess =
		fieldPolicy.access === "viewerEntry" ||
		fieldPolicy.access === "viewerEntryArg" ||
		fieldPolicy.access === "viewerTournamentMember";
	const identity = viewerAccess
		? authorizeViewerEntry(principal)
		: authorizeProtectedBinding(principal);
	if (!identity.ok) return identity;
	if (!principal) return identity;
	const viewerEntryId = viewerEntryIdForPrincipal(principal);

	if (
		(fieldPolicy.access === "verifiedEntry" || fieldPolicy.access === "verifiedEntryArg") &&
		!hasVerifiedEntry(principal)
	) {
		return {
			ok: false,
			status: 403,
			code: "FORBIDDEN",
			message: "A verified FPL binding is required",
		};
	}

	if (fieldPolicy.access === "verifiedEntryArg") {
		const entryId = asPositiveInt(field.args[fieldPolicy.arg ?? "entryId"]);
		if (!entryId || entryId !== principal.fplEntryId) {
			return {
				ok: false,
				status: 403,
				code: "FORBIDDEN",
				message: "Requested entry is not the verified administrator identity",
			};
		}
	}

	const entryArgName = viewerEntryArgFields.get(field.name);
	if (entryArgName) {
		const ownResult = requireViewerEntry(principal, asPositiveInt(field.args[entryArgName]));
		if (!ownResult.ok) return ownResult;
	}

	if (field.name === "calcLivePointsForEntries") {
		const entryIds = Array.isArray(field.args.entryIds) ? field.args.entryIds : [];
		if (
			entryIds.length === 0 ||
			!hasVerifiedEntry(principal) ||
			entryIds.some((entryId) => entryId !== principal.fplEntryId)
		) {
			return {
				ok: false,
				status: 403,
				code: "FORBIDDEN",
				message: "Requested entries are not bound to this user",
			};
		}
	}

	if (fieldPolicy.tournamentMember === true) {
		const tournamentId = asPositiveInt(field.args.tournamentId);
		if (!tournamentId || !viewerEntryId) {
			return {
				ok: false,
				status: 403,
				code: "FORBIDDEN",
				message: "User is not a member of this tournament",
			};
		}
		if (!hasPlatformAdminAccess(principal)) {
			const isMember = await hasTournamentMembership(
				dataClient,
				tournamentId,
				viewerEntryId,
				requestScope,
				authorizedTournamentMemberships
			);
			const isRetainedAdmin =
				fieldPolicy.retainedAdmin &&
				!isMember &&
				hasVerifiedEntry(principal) &&
				(await isTournamentAdmin(dataClient, tournamentId, principal.fplEntryId!, requestScope));
			if (!isMember && !isRetainedAdmin) {
				return {
					ok: false,
					status: 403,
					code: "FORBIDDEN",
					message: "User is not a member or retained administrator of this tournament",
				};
			}
		}
	}

	if (field.name === "managedTournament") {
		const tournamentId = asPositiveInt(field.args.tournamentId);
		if (
			!tournamentId ||
			!hasVerifiedEntry(principal) ||
			(!hasPlatformAdminAccess(principal) &&
				!(await isTournamentAdmin(dataClient, tournamentId, principal.fplEntryId!, requestScope)))
		) {
			return {
				ok: false,
				status: 403,
				code: "FORBIDDEN",
				message: "User is not the administrator of this tournament",
			};
		}
	}

	if (field.name === "managedTournamentStatus") {
		const tournamentId = asPositiveInt(field.args.tournamentId);
		if (
			!tournamentId ||
			!hasVerifiedEntry(principal) ||
			(!hasPlatformAdminAccess(principal) &&
				!(await isTournamentAdmin(dataClient, tournamentId, principal.fplEntryId!, requestScope)))
		) {
			return {
				ok: false,
				status: 403,
				code: "FORBIDDEN",
				message: "User is not the administrator of this tournament",
			};
		}
	}

	if (field.name === "leagueEventResults") {
		const leagueId = asPositiveInt(field.args.leagueId);
		if (
			!leagueId ||
			!hasVerifiedEntry(principal) ||
			(!hasPlatformAdminAccess(principal) &&
				!(await hasLeagueMembership(dataClient, leagueId, principal.fplEntryId!)))
		) {
			return {
				ok: false,
				status: 403,
				code: "FORBIDDEN",
				message: "User is not a member of this league",
			};
		}
	}

	return { ok: true };
};

const authorizePayload = async ({
	payload,
	principal,
	data,
	requestScope,
	authorizedTournamentMemberships,
}: {
	payload: GraphQLRequestPayload;
	principal?: Principal | null;
	data: ReadModelClient;
	requestScope?: object;
	authorizedTournamentMemberships?: Set<number>;
}): Promise<AuthorizationResult> => {
	if (typeof payload.query !== "string") return { ok: true };

	const analysis = analyzeGraphQLOperation(payload);
	if (!analysis.operation) return { ok: true };

	for (const field of analysis.rootFields) {
		const result = await authorizeRootField(
			field,
			principal,
			data,
			requestScope,
			authorizedTournamentMemberships
		);
		if (!result.ok) return result;
	}

	return { ok: true };
};

export const authorizeGraphQLRequest = async (
	input: AuthorizationInput
): Promise<AuthorizationResult> => {
	let payloads: GraphQLRequestPayload[];
	try {
		payloads = getRequestPayloads(input.body);
	} catch {
		return {
			ok: false,
			status: 403,
			code: "FORBIDDEN",
			message: "Invalid GraphQL request variables",
		};
	}

	for (const payload of payloads) {
		try {
			const result = await authorizePayload({
				payload,
				principal: input.principal,
				data: input.data,
				requestScope: input.requestScope,
				authorizedTournamentMemberships: input.authorizedTournamentMemberships,
			});
			if (!result.ok) return result;
		} catch (error) {
			input.logger.warn({ err: error }, "GraphQL authorization failed");
			return {
				ok: false,
				status: 403,
				code: "FORBIDDEN",
				message: "GraphQL request is not authorized",
			};
		}
	}

	return { ok: true };
};

export const graphQLErrorResponse = (
	result: Exclude<AuthorizationResult, { ok: true }>,
	corsHeaders: Record<string, string>,
	requestId = corsHeaders["X-Request-Id"] ?? "unavailable"
): Response =>
	new Response(
		JSON.stringify({
			errors: [
				{
					message: result.message,
					extensions: { code: result.code, requestId },
				},
			],
		}),
		{
			status: result.status,
			headers: {
				"Content-Type": "application/json",
				...corsHeaders,
			},
		}
	);
