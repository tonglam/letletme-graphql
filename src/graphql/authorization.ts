import type { SupabaseClient } from "@supabase/supabase-js";
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
import { env } from "../infra/env";
import type { Logger } from "../infra/logger";
import type { Principal } from "../infra/principal";

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
	supabase: SupabaseClient;
	logger: Logger;
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
	"me",
	"event",
	"events",
	"currentEventInfo",
	"fixtures",
	"eventFixtures",
	"liveScores",
	"playerLive",
	"eventLive",
	"eventLiveExplain",
	"liveMatches",
	"player",
	"players",
	"playersForPicker",
	"team",
	"teams",
	"topTransfersIn",
	"topTransfersOut",
	"playerValues",
	"playerValueHistory",
	"playerDetail",
	"miniProgramNotice",
	"eventOverallResult",
	"entry",
	"createWechatApiSession",
	"identifyWechatUser",
]);

const websiteOnlyFields = new Set(["myDevices", "revokeDevice", "bindFplEntry"]);

const ownEntryArgFields = new Map([
	["entryHistory", "entryId"],
	["entryEventResult", "entryId"],
	["entryTransferHistory", "entryId"],
	["entryLive", "entryId"],
	["calcLivePointsByEntry", "entryId"],
	["entryLeagues", "entryId"],
	["entryH2HMatchResults", "entryId"],
	["entryTournaments", "entryId"],
	["tournamentEntryRankingSummary", "entryId"],
]);

const tournamentMembershipFields = new Set([
	"tournamentEntryIds",
	"tournamentEventResults",
	"tournamentBattleGroupResults",
	"tournamentSelectionStats",
	"calcLivePointsForTournament",
	"tournamentEntryRankingSummary",
]);

const getOperation = (
	document: DocumentNode,
	operationName: string | null,
): OperationDefinitionNode | null => {
	const operations = document.definitions.filter(
		(definition): definition is OperationDefinitionNode =>
			definition.kind === Kind.OPERATION_DEFINITION,
	);
	if (operationName) {
		return (
			operations.find((operation) => operation.name?.value === operationName) ??
			null
		);
	}
	return operations.length === 1 ? operations[0] : null;
};

const getFragments = (
	document: DocumentNode,
): Map<string, FragmentDefinitionNode> => {
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
	variables: Record<string, unknown>,
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
	seenFragments = new Set<string>(),
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
			collectRootFields(
				selection.selectionSet,
				fragments,
				variables,
				fields,
				seenFragments,
			);
			continue;
		}
		const fragmentName = selection.name.value;
		if (seenFragments.has(fragmentName)) continue;
		const fragment = fragments.get(fragmentName);
		if (!fragment) continue;
		seenFragments.add(fragmentName);
		collectRootFields(
			fragment.selectionSet,
			fragments,
			variables,
			fields,
			seenFragments,
		);
	}
	return fields;
};

const getRequestPayloads = (
	body: unknown,
	searchParams: URLSearchParams,
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
	typeof value === "number" && Number.isInteger(value) && value > 0
		? value
		: null;

const requirePrincipal = (principal?: Principal | null): AuthorizationResult =>
	principal
		? { ok: true }
		: {
				ok: false,
				status: 401,
				code: "UNAUTHENTICATED",
				message: "Authentication required",
			};

const requireBoundEntry = (
	principal: Principal,
	entryId: number | null,
): AuthorizationResult => {
	if (!entryId || !principal.fplEntryId || entryId !== principal.fplEntryId) {
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
	supabase: SupabaseClient,
	tournamentId: number,
	entryId: number,
): Promise<boolean> => {
	const { data, error } = await supabase
		.from("tournament_entries")
		.select("entry_id")
		.eq("tournament_id", tournamentId)
		.eq("entry_id", entryId)
		.limit(1);
	if (error) return false;
	return ((data as { entry_id: number }[] | null) ?? []).length > 0;
};

const hasLeagueMembership = async (
	supabase: SupabaseClient,
	leagueId: number,
	entryId: number,
): Promise<boolean> => {
	const { data, error } = await supabase
		.from("entry_league_infos")
		.select("entry_id")
		.eq("league_id", leagueId)
		.eq("entry_id", entryId)
		.limit(1);
	if (error) return false;
	return ((data as { entry_id: number }[] | null) ?? []).length > 0;
};

const authorizeRootField = async (
	field: RootField,
	principal: Principal | null | undefined,
	supabase: SupabaseClient,
): Promise<AuthorizationResult> => {
	if (publicFields.has(field.name)) return { ok: true };

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

	const entryArgName = ownEntryArgFields.get(field.name);
	if (entryArgName) {
		const ownResult = requireBoundEntry(
			principal,
			asPositiveInt(field.args[entryArgName]),
		);
		if (!ownResult.ok) return ownResult;
	}

	if (field.name === "calcLivePointsForEntries") {
		const entryIds = Array.isArray(field.args.entryIds)
			? field.args.entryIds
			: [];
		if (
			entryIds.length === 0 ||
			!principal.fplEntryId ||
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
		if (
			!tournamentId ||
			!principal.fplEntryId ||
			!(await hasTournamentMembership(
				supabase,
				tournamentId,
				principal.fplEntryId,
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

	if (field.name === "leagueEventResults") {
		const leagueId = asPositiveInt(field.args.leagueId);
		if (
			!leagueId ||
			!principal.fplEntryId ||
			!(await hasLeagueMembership(supabase, leagueId, principal.fplEntryId))
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
	supabase,
}: {
	payload: GraphQLRequestPayload;
	principal?: Principal | null;
	supabase: SupabaseClient;
}): Promise<AuthorizationResult> => {
	if (typeof payload.query !== "string") return { ok: true };

	const document = parse(payload.query);
	const operationName =
		typeof payload.operationName === "string" ? payload.operationName : null;
	const operation = getOperation(document, operationName);
	if (!operation) return { ok: true };

	const variables = asVariables(payload.variables);
	const fields = collectRootFields(
		operation.selectionSet,
		getFragments(document),
		variables,
	);

	for (const field of fields) {
		const result = await authorizeRootField(field, principal, supabase);
		if (!result.ok) return result;
	}

	return { ok: true };
};

export const authorizeGraphQLRequest = async (
	input: AuthorizationInput,
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
				supabase: input.supabase,
			});
			if (!result.ok) {
				if (env.GRAPHQL_AUTH_MODE === "report") {
					input.logger.warn(
						{ code: result.code, message: result.message },
						"GraphQL auth report-only violation",
					);
					continue;
				}
				return result;
			}
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
		},
	);
