import {
	Kind,
	getNamedType,
	isInterfaceType,
	isObjectType,
	isUnionType,
	parse,
	valueFromASTUntyped,
	visit,
	type GraphQLArgument,
	type GraphQLCompositeType,
	type GraphQLNamedType,
	type GraphQLSchema,
	type DocumentNode,
	type FragmentDefinitionNode,
	type OperationDefinitionNode,
	type SelectionSetNode,
} from "graphql";

export const GRAPHQL_LIMITS = {
	maxDepth: 10,
	maxRootFields: 5,
	maxAliases: 20,
	maxAstNodes: 200,
	maxBoundedDeskAstNodes: 400,
	maxPlayerStatsDeskAstNodes: 240,
	maxPlayerStateProfileAstNodes: 240,
	maxComplexity: 600,
} as const;

// The detail desk intentionally projects both the setup/live and official-H2H
// branches in one response so the Web route can keep a single request. Keep the
// general document cap strict, but give this one bounded root enough AST room
// without relaxing depth, alias, root-field, or weighted-complexity guards.
const TOURNAMENT_DETAIL_DESK_MAX_AST_NODES = 400;
const PLAYER_STATS_DESK_MAX_AST_NODES = 240;
const PLAYER_STATE_PROFILE_MAX_AST_NODES = 240;
// The single-entry live-points response projects a fixed 15-player squad plus
// revision provenance and the bounded effective lineup. Give only this exact
// root enough document room while retaining every weighted-complexity, depth,
// alias, root-field, and rate-limit guard below.
const CALC_LIVE_POINTS_MAX_AST_NODES = 260;
// The live competition board returns at most one bounded page plus the viewer
// row, but each score carries the same traceability contract as live points.
// Scope the larger document allowance to this sole unaliased root; page-size,
// weighted-complexity, depth and rate-limit guards remain unchanged.
const ENTRY_LIVE_COMPETITION_BOARD_MAX_AST_NODES = 400;

const MAX_LIST_ARGUMENT_WEIGHT = 200;

// These roots contain a bounded list alongside fixed-size sibling projections.
// Charge the requested list once, but do not multiply unrelated siblings by it.
const NON_PROPAGATING_LIMIT_ROOTS = new Set(["playerStatsBootstrap"]);

type GraphQLPayload = {
	query?: unknown;
	variables?: unknown;
	operationName?: unknown;
};

export type GraphQLRequestShape = "query" | "mutation" | "subscription" | "unknown";

export type GraphQLLimitResult =
	| {
			ok: true;
			shape: GraphQLRequestShape;
			weightedComplexity: number;
			rateLimitCostUnits: number;
			rootFields: readonly string[];
	  }
	| {
			ok: false;
			message: string;
			code:
				| "QUERY_TOO_COMPLEX"
				| "DUPLICATE_ENTRY_IDS"
				| "BATCHING_DISABLED"
				| "INVALID_GRAPHQL_REQUEST";
	  };

const asVariables = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

const operationFor = (
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
	return operations.length === 1 ? (operations[0] ?? null) : null;
};

const fragmentsFor = (document: DocumentNode): Map<string, FragmentDefinitionNode> =>
	new Map(
		document.definitions
			.filter(
				(definition): definition is FragmentDefinitionNode =>
					definition.kind === Kind.FRAGMENT_DEFINITION
			)
			.map((fragment) => [fragment.name.value, fragment])
	);

type EffectiveRootField = {
	name: string;
	responseKey: string;
};

const effectiveRootFieldsFor = (
	operation: OperationDefinitionNode,
	fragments: Map<string, FragmentDefinitionNode>
): { fields: EffectiveRootField[]; reachableFragments: Set<string> } => {
	const fields: EffectiveRootField[] = [];
	const reachableFragments = new Set<string>();
	const collectNestedFragments = (selectionSet: SelectionSetNode): void => {
		for (const selection of selectionSet.selections) {
			if (selection.kind === Kind.FIELD) {
				if (selection.selectionSet) collectNestedFragments(selection.selectionSet);
				continue;
			}
			if (selection.kind === Kind.INLINE_FRAGMENT) {
				collectNestedFragments(selection.selectionSet);
				continue;
			}
			if (reachableFragments.has(selection.name.value)) continue;
			const fragment = fragments.get(selection.name.value);
			if (fragment) {
				reachableFragments.add(selection.name.value);
				collectNestedFragments(fragment.selectionSet);
			}
		}
	};
	const collect = (selectionSet: SelectionSetNode): void => {
		for (const selection of selectionSet.selections) {
			if (selection.kind === Kind.FIELD) {
				fields.push({
					name: selection.name.value,
					responseKey: selection.alias?.value ?? selection.name.value,
				});
				if (selection.selectionSet) collectNestedFragments(selection.selectionSet);
				continue;
			}
			if (selection.kind === Kind.INLINE_FRAGMENT) {
				collect(selection.selectionSet);
				continue;
			}
			if (reachableFragments.has(selection.name.value)) {
				continue;
			}
			const fragment = fragments.get(selection.name.value);
			if (fragment) {
				reachableFragments.add(selection.name.value);
				collect(fragment.selectionSet);
			}
		}
	};
	collect(operation.selectionSet);
	return { fields, reachableFragments };
};

const asCompositeType = (
	value: GraphQLNamedType | null | undefined
): GraphQLCompositeType | null =>
	value && (isObjectType(value) || isInterfaceType(value) || isUnionType(value)) ? value : null;

type ListWeight = {
	multiplier: number;
	propagateToChildren: boolean;
	oversizedEntryBatch: boolean;
	oversizedLiveExplainBatch: boolean;
	duplicateEntryIds: boolean;
	negativeListLimit: boolean;
	uniqueEntryCount: number | null;
};

const listWeight = (
	fieldArguments: readonly {
		name: { value: string };
		value: Parameters<typeof valueFromASTUntyped>[0];
	}[],
	variables: Record<string, unknown>,
	schemaArguments: readonly GraphQLArgument[] = []
): ListWeight => {
	let multiplier = 1;
	let hasEntryIds = false;
	let oversizedEntryBatch = false;
	let oversizedLiveExplainBatch = false;
	let duplicateEntryIds = false;
	let negativeListLimit = false;
	let uniqueEntryCount: number | null = null;
	const argumentValues = new Map<string, unknown>();
	for (const argument of schemaArguments) {
		if (argument.defaultValue !== undefined) {
			argumentValues.set(argument.name, argument.defaultValue);
		}
	}
	for (const argument of fieldArguments) {
		const suppliedValue = valueFromASTUntyped(argument.value, variables);
		// GraphQL preserves an explicit null, but the list resolvers use nullish
		// fallbacks that match their schema defaults. Keep that effective default
		// for safety accounting so `limit: null` cannot make a large list look cheap.
		const preservesEffectiveDefault =
			suppliedValue === null && argumentValues.has(argument.name.value);
		if (
			!preservesEffectiveDefault &&
			(suppliedValue !== undefined || !argumentValues.has(argument.name.value))
		) {
			argumentValues.set(argument.name.value, suppliedValue);
		}
	}
	for (const [name, value] of argumentValues) {
		if (name === "entryIds" && Array.isArray(value)) {
			hasEntryIds = true;
			uniqueEntryCount = new Set(value).size;
			duplicateEntryIds ||= uniqueEntryCount !== value.length;
			oversizedEntryBatch ||= value.length > 500;
			multiplier = Math.max(multiplier, Math.min(value.length, 500));
		}
		if (name === "elementIds" && Array.isArray(value)) {
			oversizedLiveExplainBatch ||= value.length > 15;
			multiplier = Math.max(multiplier, Math.min(value.length, 15));
		}
		if (["first", "last", "limit"].includes(name) && typeof value === "number") {
			negativeListLimit ||= value < 0;
			multiplier = Math.max(multiplier, Math.min(Math.max(value, 1), MAX_LIST_ARGUMENT_WEIGHT));
		}
		if (name === "offset" && typeof value === "number") {
			negativeListLimit ||= value < 0;
		}
	}
	return {
		multiplier,
		// Batch resolver work is charged once at the root. Reapplying the full
		// entry count to every selected response field makes the documented
		// 500-entry limit impossible to use. Ordinary paginated lists continue
		// propagating their multiplier through their child selection.
		propagateToChildren: !hasEntryIds,
		oversizedEntryBatch,
		oversizedLiveExplainBatch,
		duplicateEntryIds,
		negativeListLimit,
		uniqueEntryCount,
	};
};

const variablesWithDefaults = (
	operation: OperationDefinitionNode,
	suppliedVariables: Record<string, unknown>
): Record<string, unknown> => {
	const variables = { ...suppliedVariables };
	for (const definition of operation.variableDefinitions ?? []) {
		const name = definition.variable.name.value;
		if (!Object.hasOwn(variables, name) && definition.defaultValue) {
			variables[name] = valueFromASTUntyped(definition.defaultValue);
		}
	}
	return variables;
};

const inspectSelectionSet = ({
	selectionSet,
	fragments,
	variables,
	depth,
	multiplier,
	seenFragments,
	schema,
	parentType,
}: {
	selectionSet: SelectionSetNode;
	fragments: Map<string, FragmentDefinitionNode>;
	variables: Record<string, unknown>;
	depth: number;
	multiplier: number;
	seenFragments: Set<string>;
	schema?: GraphQLSchema;
	parentType: GraphQLCompositeType | null;
}): {
	maxDepth: number;
	aliases: number;
	complexity: number;
	rootFields: Array<{ name: string; uniqueEntryCount: number | null }>;
	oversizedEntryBatch: boolean;
	oversizedLiveExplainBatch: boolean;
	duplicateEntryIds: boolean;
	negativeListLimit: boolean;
} => {
	let maxDepth = depth;
	let aliases = 0;
	let complexity = 0;
	const rootFields: Array<{ name: string; uniqueEntryCount: number | null }> = [];
	let oversizedEntryBatch = false;
	let oversizedLiveExplainBatch = false;
	let duplicateEntryIds = false;
	let negativeListLimit = false;

	for (const selection of selectionSet.selections) {
		if (selection.kind === Kind.FIELD) {
			if (selection.alias) aliases += 1;
			const isIntrospectionField = selection.name.value.startsWith("__");
			const fieldDefinition =
				parentType && (isObjectType(parentType) || isInterfaceType(parentType))
					? parentType.getFields()[selection.name.value]
					: undefined;
			const weight = listWeight(selection.arguments ?? [], variables, fieldDefinition?.args ?? []);
			if (depth === 1) {
				rootFields.push({
					name: selection.name.value,
					uniqueEntryCount: weight.uniqueEntryCount,
				});
			}
			const childMultiplier = multiplier * weight.multiplier;
			const propagateToChildren =
				weight.propagateToChildren &&
				!(depth === 1 && NON_PROPAGATING_LIMIT_ROOTS.has(selection.name.value));
			oversizedEntryBatch ||= weight.oversizedEntryBatch;
			oversizedLiveExplainBatch ||= weight.oversizedLiveExplainBatch;
			duplicateEntryIds ||= weight.duplicateEntryIds;
			negativeListLimit ||= weight.negativeListLimit;
			complexity += childMultiplier;
			// Apollo exposes introspection only outside production, and the
			// graphql-depth-limit validator already treats __ fields as leaves.
			// Mirror that behavior here so development schema verification is not
			// rejected by the independent request guard before Apollo sees it.
			if (isIntrospectionField) continue;
			if (selection.selectionSet) {
				const namedChildType = fieldDefinition ? getNamedType(fieldDefinition.type) : null;
				const child = inspectSelectionSet({
					selectionSet: selection.selectionSet,
					fragments,
					variables,
					depth: depth + 1,
					multiplier: propagateToChildren ? childMultiplier : multiplier,
					seenFragments: new Set(seenFragments),
					schema,
					parentType: asCompositeType(namedChildType),
				});
				maxDepth = Math.max(maxDepth, child.maxDepth);
				aliases += child.aliases;
				complexity += child.complexity;
				oversizedEntryBatch ||= child.oversizedEntryBatch;
				oversizedLiveExplainBatch ||= child.oversizedLiveExplainBatch;
				duplicateEntryIds ||= child.duplicateEntryIds;
				negativeListLimit ||= child.negativeListLimit;
			}
			continue;
		}
		if (selection.kind === Kind.INLINE_FRAGMENT) {
			const fragmentType = selection.typeCondition
				? schema?.getType(selection.typeCondition.name.value)
				: parentType;
			const child = inspectSelectionSet({
				selectionSet: selection.selectionSet,
				fragments,
				variables,
				depth,
				multiplier,
				seenFragments: new Set(seenFragments),
				schema,
				parentType: asCompositeType(fragmentType) ?? parentType,
			});
			maxDepth = Math.max(maxDepth, child.maxDepth);
			aliases += child.aliases;
			complexity += child.complexity;
			oversizedEntryBatch ||= child.oversizedEntryBatch;
			oversizedLiveExplainBatch ||= child.oversizedLiveExplainBatch;
			duplicateEntryIds ||= child.duplicateEntryIds;
			negativeListLimit ||= child.negativeListLimit;
			rootFields.push(...child.rootFields);
			continue;
		}
		const fragmentName = selection.name.value;
		if (seenFragments.has(fragmentName)) continue;
		const fragment = fragments.get(fragmentName);
		if (!fragment) continue;
		const nextSeen = new Set(seenFragments);
		nextSeen.add(fragmentName);
		const fragmentType = schema?.getType(fragment.typeCondition.name.value);
		const child = inspectSelectionSet({
			selectionSet: fragment.selectionSet,
			fragments,
			variables,
			depth,
			multiplier,
			seenFragments: nextSeen,
			schema,
			parentType: asCompositeType(fragmentType) ?? parentType,
		});
		maxDepth = Math.max(maxDepth, child.maxDepth);
		aliases += child.aliases;
		complexity += child.complexity;
		oversizedEntryBatch ||= child.oversizedEntryBatch;
		oversizedLiveExplainBatch ||= child.oversizedLiveExplainBatch;
		duplicateEntryIds ||= child.duplicateEntryIds;
		negativeListLimit ||= child.negativeListLimit;
		rootFields.push(...child.rootFields);
	}

	return {
		maxDepth,
		aliases,
		complexity,
		rootFields,
		oversizedEntryBatch,
		oversizedLiveExplainBatch,
		duplicateEntryIds,
		negativeListLimit,
	};
};

const reject = (
	message: string,
	code:
		| "QUERY_TOO_COMPLEX"
		| "DUPLICATE_ENTRY_IDS"
		| "BATCHING_DISABLED"
		| "INVALID_GRAPHQL_REQUEST" = "QUERY_TOO_COMPLEX"
): GraphQLLimitResult => ({
	ok: false,
	code,
	message,
});

const ROOT_RATE_LIMIT_FLOORS = new Map<string, number>([
	["liveScores", 5],
	["eventLive", 5],
	["eventLiveExplains", 5],
	["eventOverallResult", 5],
	["playerDetail", 5],
	["playerStateProfile", 5],
	["playerStatsDesk", 5],
	["gameweekDesk", 5],
	["teamSelectionDesk", 5],
	["homePublicBootstrap", 5],
	["homeGameweek", 5],
	["homeMarketPulse", 5],
	["homeMarketDesk", 5],
	["playerStatsBootstrap", 10],
	["homePersonalDesk", 30],
	["briefingWeek", 5],
	["briefingStory", 5],
	["playerValueHistory", 5],
	["marketPulse", 10],
	["marketAvailabilityPage", 5],
	["priceChangeBoard", 10],
	["priceChangeLiveCursor", 1],
	["priceChangeLiveBoard", 10],
	["marketOwnershipOverview", 10],
	["marketOwnershipDay", 10],
	["marketSnapshotContext", 1],
	["playerValues", 5],
	["eventFixtures", 5],
	["currentEvent", 1],
	["currentEventInfo", 1],
	["teams", 2],
	["miniProgramNotice", 1],
	["publicLeagueTrends", 10],
	["publicLeagueSelectionStats", 10],
	["trendCohorts", 5],
	["trendCohortSnapshot", 10],
	["calcLivePointsByEntry", 10],
	["searchEntries", 10],
	["entry", 5],
	["entryNameUsage", 5],
	["tournamentEventResults", 30],
	["tournamentSelectionStats", 10],
	["tournamentEntryRankingSummary", 10],
	["entryOfficialH2HDesk", 30],
	["tournamentParticipants", 30],
	["tournamentSeasonSnapshot", 30],
	["tournamentOfficialH2H", 30],
	["tournamentDetailDesk", 30],
	["managedTournamentStatus", 2],
	["myFplTeamDesk", 5],
	["myFplTeamGameweek", 5],
	["myFplTeamTransfers", 5],
	["myFplCompetitionsDesk", 10],
	["myFplCompetitionBoard", 10],
	["myFplCompetitionSeasonPath", 5],
	["myFplCompetitionSetupStatus", 5],
]);

const heavyRootCost = (
	rootFields: Array<{ name: string; uniqueEntryCount: number | null }>
): number =>
	rootFields.reduce((total, field) => {
		if (field.name === "calcLivePointsForEntries") {
			return total + Math.max(10, field.uniqueEntryCount ?? 0);
		}
		return total + (ROOT_RATE_LIMIT_FLOORS.get(field.name) ?? 0);
	}, 0);

const accepted = ({
	shape,
	weightedComplexity = 0,
	rootFields = [],
}: {
	shape: GraphQLRequestShape;
	weightedComplexity?: number;
	rootFields?: Array<{ name: string; uniqueEntryCount: number | null }>;
}): GraphQLLimitResult => {
	const boundedPublicDeskRoots = new Set([
		"playersForPicker",
		"playerStatsBootstrap",
		"marketAvailabilityPage",
		"marketPulse",
		"priceChangeBoard",
		"priceChangeLiveBoard",
		"marketOwnershipOverview",
		"marketOwnershipDay",
		"marketSnapshotContext",
		"playerValues",
		"eventFixtures",
		"currentEvent",
		"currentEventInfo",
		"teams",
		"miniProgramNotice",
	]);
	const boundedPublicDeskRequest =
		rootFields.length > 0 && rootFields.every((field) => boundedPublicDeskRoots.has(field.name));
	const optimizedMyFplRoots = new Set([
		"myFplTeamDesk",
		"myFplTeamGameweek",
		"myFplTeamTransfers",
		"myFplCompetitionsDesk",
		"myFplCompetitionBoard",
		"myFplCompetitionSeasonPath",
		"myFplCompetitionSetupStatus",
	]);
	const optimizedMyFplRequest =
		rootFields.length > 0 && rootFields.every((field) => optimizedMyFplRoots.has(field.name));
	return {
		ok: true,
		shape,
		weightedComplexity,
		rateLimitCostUnits: boundedPublicDeskRequest
			? Math.max(5 * rootFields.length, heavyRootCost(rootFields))
			: optimizedMyFplRequest
				? heavyRootCost(rootFields)
				: Math.max(1, Math.ceil(weightedComplexity / 10), heavyRootCost(rootFields)),
		rootFields: rootFields.map((field) => field.name),
	};
};

export const validateGraphQLPayloadLimits = (
	payload: GraphQLPayload,
	schema?: GraphQLSchema
): GraphQLLimitResult => {
	if (typeof payload.query !== "string") {
		return reject("GraphQL request body must contain a query string", "INVALID_GRAPHQL_REQUEST");
	}

	let document: DocumentNode;
	try {
		document = parse(payload.query);
	} catch {
		return accepted({ shape: "unknown" });
	}

	const operation = operationFor(
		document,
		typeof payload.operationName === "string" ? payload.operationName : null
	);
	const fragments = fragmentsFor(document);
	const rootInspection = operation
		? effectiveRootFieldsFor(operation, fragments)
		: { fields: [], reachableFragments: new Set<string>() };
	const rootNames = rootInspection.fields;
	const onlyReachableDefinitions =
		operation !== null &&
		document.definitions.every((definition) =>
			definition.kind === Kind.OPERATION_DEFINITION
				? definition === operation
				: definition.kind === Kind.FRAGMENT_DEFINITION
					? rootInspection.reachableFragments.has(definition.name.value)
					: false
		);
	const responseKeys = new Set(rootNames.map((field) => field.responseKey));
	const usesTournamentDetailDesk =
		onlyReachableDefinitions &&
		responseKeys.size === 1 &&
		rootNames.length > 0 &&
		rootNames.every(
			(field) =>
				field.name === "tournamentDetailDesk" && field.responseKey === "tournamentDetailDesk"
		);
	const usesMyFplCompetitionsDesk =
		onlyReachableDefinitions &&
		responseKeys.size === 1 &&
		rootNames.length > 0 &&
		rootNames.every(
			(field) =>
				field.name === "myFplCompetitionsDesk" && field.responseKey === "myFplCompetitionsDesk"
		);
	const usesPlayerStatsDesk =
		onlyReachableDefinitions &&
		responseKeys.size === 1 &&
		rootNames.length > 0 &&
		rootNames.every(
			(field) => field.name === "playerStatsDesk" && field.responseKey === "playerStatsDesk"
		);
	const usesPlayerStateProfile =
		onlyReachableDefinitions &&
		responseKeys.size === 1 &&
		rootNames.length > 0 &&
		rootNames.every(
			(field) => field.name === "playerStateProfile" && field.responseKey === "playerStateProfile"
		);
	const usesCalcLivePointsByEntry =
		onlyReachableDefinitions &&
		responseKeys.size === 1 &&
		rootNames.length > 0 &&
		rootNames.every(
			(field) =>
				field.name === "calcLivePointsByEntry" && field.responseKey === "calcLivePointsByEntry"
		);
	const usesEntryLiveCompetitionBoard =
		onlyReachableDefinitions &&
		responseKeys.size === 1 &&
		rootNames.length > 0 &&
		rootNames.every(
			(field) =>
				field.name === "entryLiveCompetitionBoard" &&
				field.responseKey === "entryLiveCompetitionBoard"
		);
	const maxAstNodes = usesTournamentDetailDesk
		? TOURNAMENT_DETAIL_DESK_MAX_AST_NODES
		: usesMyFplCompetitionsDesk
			? GRAPHQL_LIMITS.maxBoundedDeskAstNodes
			: usesPlayerStatsDesk
				? PLAYER_STATS_DESK_MAX_AST_NODES
				: usesPlayerStateProfile
					? PLAYER_STATE_PROFILE_MAX_AST_NODES
					: usesCalcLivePointsByEntry
						? CALC_LIVE_POINTS_MAX_AST_NODES
						: usesEntryLiveCompetitionBoard
							? ENTRY_LIVE_COMPETITION_BOARD_MAX_AST_NODES
							: GRAPHQL_LIMITS.maxAstNodes;
	let astNodes = 0;
	visit(document, { enter: () => void (astNodes += 1) });
	if (astNodes > maxAstNodes) {
		return reject(`GraphQL document exceeds ${maxAstNodes} AST nodes`);
	}

	if (!operation) {
		return accepted({ shape: "unknown" });
	}

	const variables = variablesWithDefaults(operation, asVariables(payload.variables));
	const inspection = inspectSelectionSet({
		selectionSet: operation.selectionSet,
		fragments: fragmentsFor(document),
		variables,
		depth: 1,
		multiplier: 1,
		seenFragments: new Set(),
		schema,
		parentType:
			operation.operation === "query"
				? (schema?.getQueryType() ?? null)
				: operation.operation === "mutation"
					? (schema?.getMutationType() ?? null)
					: (schema?.getSubscriptionType() ?? null),
	});
	if (inspection.maxDepth > GRAPHQL_LIMITS.maxDepth) {
		return reject(`GraphQL query depth exceeds ${GRAPHQL_LIMITS.maxDepth}`);
	}
	if (inspection.rootFields.length > GRAPHQL_LIMITS.maxRootFields) {
		return reject(`GraphQL operation exceeds ${GRAPHQL_LIMITS.maxRootFields} root fields`);
	}
	if (inspection.aliases > GRAPHQL_LIMITS.maxAliases) {
		return reject(`GraphQL operation exceeds ${GRAPHQL_LIMITS.maxAliases} aliases`);
	}
	if (inspection.negativeListLimit) {
		return reject("GraphQL list limits must not be negative");
	}
	if (inspection.duplicateEntryIds) {
		return reject("GraphQL entryIds must not contain duplicates", "DUPLICATE_ENTRY_IDS");
	}
	if (inspection.oversizedEntryBatch) {
		return reject("GraphQL entryIds batch exceeds 500 entries");
	}
	if (inspection.oversizedLiveExplainBatch) {
		return reject("GraphQL elementIds batch exceeds 15 players");
	}
	if (inspection.complexity > GRAPHQL_LIMITS.maxComplexity) {
		return reject(`GraphQL operation exceeds weighted complexity ${GRAPHQL_LIMITS.maxComplexity}`);
	}

	return accepted({
		shape: operation.operation,
		weightedComplexity: inspection.complexity,
		rootFields: inspection.rootFields,
	});
};

export const validateGraphQLRequestLimits = (
	body: unknown,
	schema?: GraphQLSchema
): GraphQLLimitResult => {
	if (Array.isArray(body)) {
		return reject("GraphQL request batching is disabled", "BATCHING_DISABLED");
	}
	if (!body || typeof body !== "object") {
		return reject("GraphQL request body must be an object", "INVALID_GRAPHQL_REQUEST");
	}
	const payloads = [body];
	let shape: GraphQLRequestShape = "unknown";
	let weightedComplexity = 0;
	let rateLimitCostUnits = 0;
	const rootFields: string[] = [];
	for (const payload of payloads) {
		if (!payload || typeof payload !== "object") {
			return reject("GraphQL request body must be an object", "INVALID_GRAPHQL_REQUEST");
		}
		const result = validateGraphQLPayloadLimits(payload as GraphQLPayload, schema);
		if (!result.ok) return result;
		if (result.shape === "mutation") shape = "mutation";
		else if (shape === "unknown") shape = result.shape;
		weightedComplexity += result.weightedComplexity;
		rateLimitCostUnits += result.rateLimitCostUnits;
		rootFields.push(...result.rootFields);
	}
	return {
		ok: true,
		shape,
		weightedComplexity,
		rateLimitCostUnits: Math.max(1, rateLimitCostUnits),
		rootFields,
	};
};
