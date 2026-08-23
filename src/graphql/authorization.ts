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
import { getRootFieldPolicy, ROOT_FIELD_POLICIES } from "./root-field-policy";
export { isGraphQLRootFieldClassified } from "./root-field-policy";

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

const ownEntryArgFields = new Map(
	[...ROOT_FIELD_POLICIES]
		.filter(
			([, value]) => value.ownEntryArg ?? (value.access === "ownEntryArg" ? value.arg : undefined)
		)
		.map(([key, value]) => [key, value.ownEntryArg ?? value.arg!] as const)
);
const protectedFields = new Set(
	[...ROOT_FIELD_POLICIES].filter(([, value]) => value.access !== "public").map(([key]) => key)
);

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

const getRequestPayloads = (body: unknown): GraphQLRequestPayload[] => {
	if (Array.isArray(body)) {
		return body as GraphQLRequestPayload[];
	}
	if (body && typeof body === "object") {
		return [body as GraphQLRequestPayload];
	}
	return [];
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

const hasPlatformAdminAccess = (principal: Principal): boolean =>
	principal.source === "website" && principal.platformAdmin === true && hasVerifiedEntry(principal);

const requireBoundEntry = (principal: Principal, entryId: number | null): AuthorizationResult => {
	if (!hasVerifiedEntry(principal) || !entryId || entryId !== principal.fplEntryId) {
		return {
			ok: false,
			status: 403,
			code: "FORBIDDEN",
			message: "Requested entry is not bound to this user",
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

const isPrivateTrendsAccess = (field: RootField): boolean =>
	(field.name === "trendCohorts" || field.name === "trendCohortSnapshot") &&
	field.args.access === "MINE";

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

const authorizeRootField = async (
	field: RootField,
	principal: Principal | null | undefined,
	dataClient: ReadModelClient,
	requestScope?: object,
	authorizedTournamentMemberships?: Set<number>
): Promise<AuthorizationResult> => {
	const fieldPolicy = getRootFieldPolicy(field.name);
	if (isPrivateTrendsAccess(field)) {
		return authorizeProtectedBinding(principal);
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

	const binding = authorizeProtectedBinding(principal);
	if (!binding.ok) return binding;
	if (!principal) return binding;

	if (fieldPolicy.access === "verifiedEntry" && !hasVerifiedEntry(principal)) {
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
			(!hasPlatformAdminAccess(principal) &&
				!(await hasTournamentMembership(
					dataClient,
					tournamentId,
					principal.fplEntryId!,
					requestScope,
					authorizedTournamentMemberships
				)))
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

	if (fieldPolicy.tournamentMember === true) {
		const tournamentId = asPositiveInt(field.args.tournamentId);
		if (!tournamentId || !hasVerifiedEntry(principal)) {
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
				principal.fplEntryId!,
				requestScope,
				authorizedTournamentMemberships
			);
			const isRetainedAdmin =
				fieldPolicy.retainedAdmin &&
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
