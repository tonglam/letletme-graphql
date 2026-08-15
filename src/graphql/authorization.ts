import {
	Kind,
	parse,
	valueFromASTUntyped,
	type ArgumentNode,
	type DocumentNode,
	type FragmentDefinitionNode,
	type OperationDefinitionNode,
	type SelectionSetNode,
} from "graphql";
import type { Logger } from "../infra/logger";
import type { Principal } from "../infra/principal";
import type { ReadModelClient } from "../infra/read-model-client";

type GraphQLRequestPayload = {
	query?: unknown;
	variables?: unknown;
	operationName?: unknown;
};

type RootField = {
	name: string;
	args: Record<string, unknown>;
};

type AuthorizationInput = {
	body: unknown;
	searchParams: URLSearchParams;
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
			code: "UNAUTHENTICATED" | "FORBIDDEN";
			message: string;
	  };

const publicFields = new Set([
	"_empty",
	"__typename",
	"__schema",
	"__type",
	"me",
	"event",
	"events",
	"currentEventInfo",
	"coreEventContext",
	"homePublicBootstrap",
	"homeGameweek",
	"homeMarketPulse",
	"playerStatsBootstrap",
	"playerStatsDesk",
	"gameweekDesk",
	"fixtures",
	"eventFixtures",
	"liveScores",
	"playerLive",
	"eventLive",
	"eventLiveExplain",
	"eventLiveExplains",
	"liveSnapshot",
	"liveContext",
	"liveMatchdayDesk",
	"liveFixturePlayers",
	"player",
	"players",
	"playersForPicker",
	"team",
	"teams",
	"topTransfersIn",
	"topTransfersOut",
	"playerValues",
	"playerValueHistory",
	"marketPulse",
	"marketSnapshotContext",
	"publicLeagueTrends",
	"publicLeagueSelectionStats",
	"trendCohorts",
	"trendCohortSnapshot",
	"playerDetail",
	"playerStateProfile",
	"miniProgramNotice",
	"eventOverallResult",
	"entry",
	"calcLivePointsByEntry",
]);

const websiteOnlyFields = new Set<string>();

const ownEntryArgFields = new Map([
	["entryHistory", "entryId"],
	["entryEventResult", "entryId"],
	["entryTransferHistory", "entryId"],
	["entryLive", "entryId"],
	["entryLeagues", "entryId"],
	["entryH2HMatchResults", "entryId"],
	["entryOfficialH2HDesk", "entryId"],
	["entryTournaments", "entryId"],
	["entryLiveCompetitionsDesk", "entryId"],
	["tournamentSelectionIndex", "entryId"],
	["tournamentEntrySquads", "entryId"],
	["tournament", "entryId"],
	["tournamentDetailDesk", "entryId"],
	["managedTournament", "entryId"],
	["tournamentEntryRankingSummary", "entryId"],
]);

const tournamentMembershipFields = new Set([
	"tournamentParticipants",
	"tournamentEntryIds",
	"tournamentEventResults",
	"tournamentBattleGroupResults",
	"tournamentOfficialH2H",
	"tournamentSelectionStats",
	"tournamentEntryRankingSummary",
	"tournamentSeasonSnapshot",
	"tournament",
	"tournamentLiveParticipants",
	"tournamentDetailDesk",
	"myFplCompetitionBoard",
	"myFplCompetitionSeasonPath",
	"myFplCompetitionSetupStatus",
]);

const verifiedEntryFields = new Set([
	"myFplTeamDesk",
	"myFplTeamGameweek",
	"myFplTeamTransfers",
	"myFplCompetitionsDesk",
]);

const protectedFields = new Set([
	...websiteOnlyFields,
	...ownEntryArgFields.keys(),
	...tournamentMembershipFields,
	"managedTournamentStatus",
	...verifiedEntryFields,
	"calcLivePointsForEntries",
	"leagueEventResults",
	"homePersonalDesk",
]);

export const isGraphQLRootFieldClassified = (fieldName: string): boolean =>
	publicFields.has(fieldName) || protectedFields.has(fieldName);

const getOperation = (
	document: DocumentNode,
	operationName: string | null
): OperationDefinitionNode | null => {
	const operations = document.definitions.filter(
		(definition): definition is OperationDefinitionNode =>
			definition.kind === Kind.OPERATION_DEFINITION
	);
	if (operationName) {
		return operations.find((operation) => operation.name?.value === operationName) ?? null;
	}
	return operations.length === 1 ? operations[0] : null;
};

const getFragments = (document: DocumentNode): Map<string, FragmentDefinitionNode> => {
	const fragments = new Map<string, FragmentDefinitionNode>();
	for (const definition of document.definitions) {
		if (definition.kind === Kind.FRAGMENT_DEFINITION) {
			fragments.set(definition.name.value, definition);
		}
	}
	return fragments;
};

const readArgs = (
	args: readonly ArgumentNode[] | undefined,
	variables: Record<string, unknown>
): Record<string, unknown> => {
	const values: Record<string, unknown> = {};
	for (const arg of args ?? []) {
		values[arg.name.value] = valueFromASTUntyped(arg.value, variables);
	}
	return values;
};

const collectRootFields = (
	selectionSet: SelectionSetNode,
	fragments: Map<string, FragmentDefinitionNode>,
	variables: Record<string, unknown>,
	fields: RootField[] = [],
	seenFragments = new Set<string>()
): RootField[] => {
	for (const selection of selectionSet.selections) {
		if (selection.kind === Kind.FIELD) {
			fields.push({
				name: selection.name.value,
				args: readArgs(selection.arguments, variables),
			});
			continue;
		}
		if (selection.kind === Kind.INLINE_FRAGMENT) {
			collectRootFields(selection.selectionSet, fragments, variables, fields, seenFragments);
			continue;
		}
		const fragmentName = selection.name.value;
		if (seenFragments.has(fragmentName)) continue;
		const fragment = fragments.get(fragmentName);
		if (!fragment) continue;
		seenFragments.add(fragmentName);
		collectRootFields(fragment.selectionSet, fragments, variables, fields, seenFragments);
	}
	return fields;
};

const getRequestPayloads = (
	body: unknown,
	searchParams: URLSearchParams
): GraphQLRequestPayload[] => {
	if (Array.isArray(body)) {
		return body as GraphQLRequestPayload[];
	}
	if (body && typeof body === "object") {
		return [body as GraphQLRequestPayload];
	}
	const query = searchParams.get("query");
	if (!query) return [];
	return [
		{
			query,
			operationName: searchParams.get("operationName"),
			variables: searchParams.get("variables")
				? JSON.parse(searchParams.get("variables") ?? "{}")
				: undefined,
		},
	];
};

const asVariables = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

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

const requireBoundEntry = (principal: Principal, entryId: number | null): AuthorizationResult => {
	if (
		!principal.fplEntryVerifiedAt ||
		!entryId ||
		!principal.fplEntryId ||
		entryId !== principal.fplEntryId
	) {
		return {
			ok: false,
			status: 403,
			code: "FORBIDDEN",
			message: "Requested entry is not bound to this user",
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
	const { data, error } = await dataClient
		.read("competition.tournament_entries")
		.select("entry_id")
		.eq("tournament_id", tournamentId)
		.eq("entry_id", entryId)
		.limit(1);
	if (error) return false;
	const value = ((data as { entry_id: number }[] | null) ?? []).length > 0;
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

const authorizeRootField = async (
	field: RootField,
	principal: Principal | null | undefined,
	dataClient: ReadModelClient,
	requestScope?: object,
	authorizedTournamentMemberships?: Set<number>
): Promise<AuthorizationResult> => {
	if (publicFields.has(field.name)) return { ok: true };
	if (!protectedFields.has(field.name)) {
		return {
			ok: false,
			status: 403,
			code: "FORBIDDEN",
			message: "GraphQL operation has no authorization policy",
		};
	}

	const principalResult = requirePrincipal(principal);
	if (!principalResult.ok) return principalResult;
	if (!principal) return principalResult;

	if (websiteOnlyFields.has(field.name) && principal.source !== "website") {
		return {
			ok: false,
			status: 403,
			code: "FORBIDDEN",
			message: "This operation requires a website session",
		};
	}

	if (field.name === "homePersonalDesk" && !hasVerifiedEntry(principal)) {
		return {
			ok: false,
			status: 403,
			code: "FORBIDDEN",
			message: "A verified FPL binding is required",
		};
	}

	if (verifiedEntryFields.has(field.name) && !hasVerifiedEntry(principal)) {
		return {
			ok: false,
			status: 403,
			code: "FORBIDDEN",
			message: "A verified FPL binding is required",
		};
	}

	if (
		field.name === "myFplCompetitionsDesk" &&
		field.args.tournamentId !== null &&
		field.args.tournamentId !== undefined
	) {
		const tournamentId = asPositiveInt(field.args.tournamentId);
		if (
			!tournamentId ||
			!(await hasTournamentMembership(
				dataClient,
				tournamentId,
				principal.fplEntryId!,
				requestScope,
				authorizedTournamentMemberships
			))
		) {
			return {
				ok: false,
				status: 403,
				code: "FORBIDDEN",
				message: "User is not a member of this tournament",
			};
		}
	}

	const entryArgName = ownEntryArgFields.get(field.name);
	if (entryArgName) {
		const ownResult = requireBoundEntry(principal, asPositiveInt(field.args[entryArgName]));
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

	if (tournamentMembershipFields.has(field.name)) {
		const tournamentId = asPositiveInt(field.args.tournamentId);
		if (!tournamentId || !hasVerifiedEntry(principal)) {
			return {
				ok: false,
				status: 403,
				code: "FORBIDDEN",
				message: "User is not a member of this tournament",
			};
		}
		const isMember = await hasTournamentMembership(
			dataClient,
			tournamentId,
			principal.fplEntryId!,
			requestScope,
			authorizedTournamentMemberships
		);
		const isRetainedAdmin =
			(field.name === "tournamentParticipants" || field.name === "tournamentDetailDesk") &&
			!isMember &&
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

	if (field.name === "managedTournament") {
		const tournamentId = asPositiveInt(field.args.tournamentId);
		if (
			!tournamentId ||
			!hasVerifiedEntry(principal) ||
			!(await isTournamentAdmin(dataClient, tournamentId, principal.fplEntryId!, requestScope))
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
			!(await isTournamentAdmin(dataClient, tournamentId, principal.fplEntryId!, requestScope))
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
			!(await hasLeagueMembership(dataClient, leagueId, principal.fplEntryId!))
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

	const document = parse(payload.query);
	const operationName = typeof payload.operationName === "string" ? payload.operationName : null;
	const operation = getOperation(document, operationName);
	if (!operation) return { ok: true };

	const variables = asVariables(payload.variables);
	const fields = collectRootFields(operation.selectionSet, getFragments(document), variables);

	for (const field of fields) {
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
		payloads = getRequestPayloads(input.body, input.searchParams);
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
	corsHeaders: Record<string, string>
): Response =>
	new Response(
		JSON.stringify({
			errors: [
				{
					message: result.message,
					extensions: { code: result.code },
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
