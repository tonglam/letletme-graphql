import {
	getNamedType,
	isEnumType,
	isInputObjectType,
	isListType,
	isNonNullType,
	isScalarType,
	type GraphQLArgument,
	type GraphQLField,
	type GraphQLNamedType,
	type GraphQLSchema,
	type GraphQLType,
} from "graphql";
import {
	ROOT_FIELD_CONDITIONAL_ACCESS,
	ROOT_FIELD_POLICIES,
	type RootFieldAccess,
} from "./root-field-policy";
import { effectiveRootRateLimitFloor } from "./limits";

export type GraphQLConditionalAuth = Readonly<{
	field: string;
	argument: string;
	equals?: string | number | boolean;
	when?: "provided";
	access: RootFieldAccess;
}>;

export type GraphQLDomainManifestEntry = Readonly<{
	name: string;
	typeDefsModules: readonly string[];
	resolversModules: readonly string[];
	rootFields: readonly string[];
	auth: readonly RootFieldAccess[];
	/** Effective authorization classes for each executable root in this domain. */
	authByRootField: Readonly<Record<string, readonly RootFieldAccess[]>>;
	conditionalAuth: readonly GraphQLConditionalAuth[];
	rateLimitBudget: Readonly<Record<string, number>>;
}>;

const domain = (
	name: string,
	moduleName: string,
	rootFields: readonly string[],
	moduleRoot = `src/domains/${moduleName}`,
	moduleFiles: Readonly<{ typeDefs: readonly string[]; resolvers: readonly string[] }> = {
		typeDefs: ["schema.ts"],
		resolvers: ["resolvers.ts"],
	}
): GraphQLDomainManifestEntry => {
	const conditionalAuth = rootFields.flatMap((field) =>
		(ROOT_FIELD_CONDITIONAL_ACCESS.get(field) ?? []).map((condition) => ({
			field,
			...condition,
		}))
	);
	const authByRootField = Object.fromEntries(
		rootFields.map((field) => {
			const accesses = new Set<RootFieldAccess>();
			const staticAccess = ROOT_FIELD_POLICIES.get(field)?.access;
			if (staticAccess) accesses.add(staticAccess);
			for (const condition of ROOT_FIELD_CONDITIONAL_ACCESS.get(field) ?? []) {
				accesses.add(condition.access);
			}
			return [field, [...accesses] as readonly RootFieldAccess[]];
		})
	) as Readonly<Record<string, readonly RootFieldAccess[]>>;
	const auth = Array.from(new Set(Object.values(authByRootField).flat())) as RootFieldAccess[];
	const rateLimitBudget = Object.fromEntries(
		rootFields.map((field) => [field, effectiveRootRateLimitFloor(field)])
	);
	return {
		name,
		typeDefsModules: moduleFiles.typeDefs.map((file) => `${moduleRoot}/${file}`),
		resolversModules: moduleFiles.resolvers.map((file) => `${moduleRoot}/${file}`),
		rootFields,
		auth,
		authByRootField,
		conditionalAuth,
		rateLimitBudget,
	};
};

/**
 * The executable GraphQL boundary is intentionally described in one small,
 * reviewable manifest.  The docs checker validates that every registered root
 * field is assigned exactly once and that its auth/rate-limit policy remains
 * sourced from the executable registries.
 */
export const GRAPHQL_DOMAIN_MANIFEST: readonly GraphQLDomainManifestEntry[] = [
	domain(
		"foundation",
		"foundation",
		["_empty", "__typename", "__schema", "__type"],
		"src/graphql",
		{
			typeDefs: ["base-schema.ts", "data-completeness.ts"],
			resolvers: ["base-schema.ts"],
		}
	),
	domain("auth", "auth", ["me"]),
	domain("events", "events", ["event", "events", "currentEventInfo", "coreEventContext"]),
	domain("gameweek", "gameweek", ["gameweekDesk"]),
	domain("home", "home", [
		"homePublicBootstrap",
		"homeGameweek",
		"homePersonalDesk",
		"homeMarketPulse",
		"homeMarketDesk",
	]),
	domain("players", "players", [
		"player",
		"players",
		"playersForPicker",
		"team",
		"teams",
		"topTransfersIn",
		"topTransfersOut",
	]),
	domain("player-values", "player-values", ["playerValues", "playerValueHistory"]),
	domain("fixtures", "fixtures", ["fixtures", "eventFixtures"]),
	domain("live", "live", [
		"liveScores",
		"playerLive",
		"eventLive",
		"eventLiveExplain",
		"eventLiveExplains",
		"liveSnapshot",
	]),
	domain("live-desks", "live-desks", [
		"liveContext",
		"liveMatchdayDesk",
		"liveFixturePlayers",
		"entryLiveCompetitionsDesk",
		"entryLiveCompetitionBoard",
		"tournamentSelectionIndex",
		"tournamentEntrySquads",
		"tournamentLiveParticipants",
	]),
	domain("mini-program", "mini-program", ["miniProgramNotice"]),
	domain("entry-live", "entry-live", [
		"entryLive",
		"calcLivePointsByEntry",
		"calcLivePointsForEntries",
	]),
	domain("market", "market", [
		"marketPulse",
		"marketAvailabilityPage",
		"marketLineup",
		"marketOwnershipOverview",
		"marketOwnershipDay",
		"marketSnapshotContext",
	]),
	domain("price-changes", "price-changes", [
		"priceChangeBoard",
		"priceChangeLiveCursor",
		"priceChangeLiveBoard",
	]),
	domain("my-fpl", "my-fpl", [
		"myFplTeamDesk",
		"myFplTeamGameweek",
		"myFplTeamTransfers",
		"myFplCompetitionsDesk",
		"myFplCompetitionBoard",
		"myFplCompetitionSeasonPath",
		"myFplCompetitionSetupStatus",
	]),
	domain("leagues", "leagues", ["entryLeagues", "leagueEventResults"]),
	domain("tournaments", "tournaments", [
		"entryParticipatingTournaments",
		"manageableTournaments",
		"tournament",
		"managedTournament",
		"tournamentParticipants",
		"tournamentEntryIds",
		"tournamentEventResults",
		"tournamentEntryRankingSummary",
		"tournamentSeasonSnapshot",
		"tournamentBattleGroupResults",
		"entryH2HMatchResults",
		"tournamentOfficialH2H",
		"entryOfficialH2HDesk",
		"tournamentDetailDesk",
		"managedTournamentStatus",
	]),
	domain("entries", "entries", [
		"entryLookup",
		"entrySnapshot",
		"entryNameUsage",
		"searchEntries",
		"entryHistory",
		"entryEventResult",
		"entryTransferHistory",
	]),
	domain("event-overall-result", "event-overall-result", ["eventOverallResult"]),
	domain("event-stats", "event-stats", ["tournamentSelectionStats"]),
	domain("public-league-trends", "public-league-trends", [
		"publicLeagueTrends",
		"publicLeagueSelectionStats",
	]),
	domain("trends", "trends", ["trendCohorts", "trendCohortSnapshot"]),
	domain("player-detail", "player-detail", ["playerDetail"]),
	domain("player-state", "player-state", ["playerStateProfile"]),
	domain("player-stats", "player-stats", ["playerStatsBootstrap", "playerStatsDesk"]),
	domain("briefing", "briefing", ["briefingWeek", "briefingStory"]),
	domain("team-selection", "team-selection", ["teamSelectionDesk"]),
] as const;

const INTROSPECTION_ROOT_FIELDS = ["__typename", "__schema", "__type"] as const;

export const executableSchemaRootFields = (schema: GraphQLSchema): ReadonlySet<string> => {
	const fields = new Set<string>(INTROSPECTION_ROOT_FIELDS);
	for (const rootType of [
		schema.getQueryType(),
		schema.getMutationType(),
		schema.getSubscriptionType(),
	]) {
		if (!rootType) continue;
		for (const field of Object.keys(rootType.getFields())) fields.add(field);
	}
	return fields;
};

const conditionalRootField = (
	schema: GraphQLSchema,
	fieldName: string
): readonly { rootTypeName: string; field: GraphQLField<unknown, unknown> }[] => {
	const matches: { rootTypeName: string; field: GraphQLField<unknown, unknown> }[] = [];
	for (const rootType of [
		schema.getQueryType(),
		schema.getMutationType(),
		schema.getSubscriptionType(),
	]) {
		if (!rootType) continue;
		const field = rootType.getFields()[fieldName];
		if (field) matches.push({ rootTypeName: rootType.name, field });
	}
	return matches;
};

const conditionalArgument = (
	field: GraphQLField<unknown, unknown>,
	argumentName: string
): GraphQLArgument | undefined => field.args.find((argument) => argument.name === argumentName);

const describeGraphQLType = (type: GraphQLType): string => {
	if (isNonNullType(type)) return `${describeGraphQLType(type.ofType)}!`;
	if (isListType(type)) return `[${describeGraphQLType(type.ofType)}]`;
	return type.name;
};

const validateConditionalEquals = (
	argument: GraphQLArgument,
	value: string | number | boolean,
	location: string
): string | undefined => {
	const nullableType = isNonNullType(argument.type) ? argument.type.ofType : argument.type;
	const inputType = getNamedType(nullableType) as GraphQLNamedType;
	if (isListType(nullableType) || isInputObjectType(inputType)) {
		return `${location}: equals is not supported for list or input-object argument type ${describeGraphQLType(argument.type)}`;
	}
	if (isEnumType(inputType)) {
		return typeof value === "string" && inputType.getValue(value)
			? undefined
			: `${location}: equals must name a value in enum ${inputType.name}`;
	}
	if (inputType.name === "Boolean") {
		return typeof value === "boolean"
			? undefined
			: `${location}: equals must be a Boolean for ${inputType.name}`;
	}
	if (inputType.name === "Int") {
		return typeof value === "number" &&
			Number.isInteger(value) &&
			value >= -2147483648 &&
			value <= 2147483647
			? undefined
			: `${location}: equals must be a 32-bit integer for ${inputType.name}`;
	}
	if (inputType.name === "Float") {
		return typeof value === "number" && Number.isFinite(value)
			? undefined
			: `${location}: equals must be a finite number for ${inputType.name}`;
	}
	if (inputType.name === "ID") {
		return (typeof value === "string" && value.length > 0) ||
			(typeof value === "number" && Number.isInteger(value) && Number.isSafeInteger(value))
			? undefined
			: `${location}: equals must be a string or integer for ID`;
	}
	if (inputType.name === "String") {
		return typeof value === "string"
			? undefined
			: `${location}: equals must be a string for ${inputType.name}`;
	}
	if (isScalarType(inputType)) {
		return `${location}: equals requires an explicit validator for custom scalar ${inputType.name}`;
	}
	return `${location}: equals has unsupported argument type ${describeGraphQLType(argument.type)}`;
};

/**
 * Validate conditional authorization rules against the executable schema, not
 * only against the TypeScript registry. A typo in an argument name otherwise
 * turns a conditional rule into a no-op at runtime and silently weakens auth.
 */
export const validateGraphQLConditionalAuthAgainstSchema = (
	schema: GraphQLSchema
): readonly string[] => {
	const errors: string[] = [];
	for (const [fieldName, conditions] of ROOT_FIELD_CONDITIONAL_ACCESS) {
		const fields = conditionalRootField(schema, fieldName);
		if (fields.length === 0) {
			errors.push(`conditional auth field is not executable: ${fieldName}`);
			continue;
		}
		for (const condition of conditions) {
			const hasWhen = condition.when !== undefined;
			const hasEquals = Object.hasOwn(condition, "equals");
			if (hasWhen === hasEquals) {
				errors.push(
					`${fieldName}.${condition.argument}: conditional auth must specify exactly one of when or equals`
				);
				continue;
			}
			if (hasWhen && condition.when !== "provided") {
				errors.push(`${fieldName}.${condition.argument}: unsupported conditional auth predicate`);
				continue;
			}
			for (const { rootTypeName, field } of fields) {
				const location = `${rootTypeName}.${fieldName}.${condition.argument}`;
				const argument = conditionalArgument(field, condition.argument);
				if (!argument) {
					errors.push(`${location}: conditional auth argument is not defined in the schema`);
					continue;
				}
				if (hasWhen) {
					if (isNonNullType(argument.type)) {
						errors.push(
							`${location}: when=provided cannot target a non-null argument ${describeGraphQLType(argument.type)}`
						);
					}
					continue;
				}
				const equalsError = validateConditionalEquals(argument, condition.equals!, location);
				if (equalsError) errors.push(equalsError);
			}
		}
	}
	return errors;
};

export const validateGraphQLDomainManifest = (schema: GraphQLSchema): readonly string[] => {
	const errors: string[] = [...validateGraphQLConditionalAuthAgainstSchema(schema)];
	const seen = new Set<string>();
	const executableFields = executableSchemaRootFields(schema);
	const expectedAuthFor = (field: string): ReadonlySet<RootFieldAccess> => {
		const expected = new Set<RootFieldAccess>();
		const staticAccess = ROOT_FIELD_POLICIES.get(field)?.access;
		if (staticAccess) expected.add(staticAccess);
		for (const condition of ROOT_FIELD_CONDITIONAL_ACCESS.get(field) ?? []) {
			expected.add(condition.access);
		}
		return expected;
	};
	for (const entry of GRAPHQL_DOMAIN_MANIFEST) {
		const declaredAuthFields = new Set(Object.keys(entry.authByRootField));
		for (const field of declaredAuthFields) {
			if (!entry.rootFields.includes(field)) {
				errors.push(`auth mapping is not a declared root field: ${field}`);
			}
		}
		for (const field of entry.rootFields) {
			if (seen.has(field)) errors.push(`duplicate root field: ${field}`);
			seen.add(field);
			if (!executableFields.has(field))
				errors.push(`manifest root field is not executable: ${field}`);
			if (!ROOT_FIELD_POLICIES.has(field)) errors.push(`unclassified root field: ${field}`);
			if (!(field in entry.rateLimitBudget)) errors.push(`missing rate-limit budget: ${field}`);
			if (entry.rateLimitBudget[field] < 1) errors.push(`invalid rate-limit floor: ${field}`);
			const expectedAuth = expectedAuthFor(field);
			const actualAuth = entry.authByRootField[field];
			if (!actualAuth) {
				errors.push(`missing per-root auth mapping: ${field}`);
			} else {
				const actual = new Set(actualAuth);
				for (const access of expectedAuth) {
					if (!actual.has(access)) {
						errors.push(`missing per-root auth class: ${field} -> ${access}`);
					}
				}
				for (const access of actual) {
					if (!expectedAuth.has(access)) {
						errors.push(`unexpected per-root auth class: ${field} -> ${access}`);
					}
				}
			}
		}
	}
	for (const field of ROOT_FIELD_POLICIES.keys()) {
		if (!seen.has(field)) errors.push(`unassigned root field: ${field}`);
	}
	for (const field of ROOT_FIELD_CONDITIONAL_ACCESS.keys()) {
		if (!seen.has(field)) errors.push(`unassigned conditional auth field: ${field}`);
	}
	for (const field of executableFields) {
		if (!seen.has(field)) errors.push(`unassigned executable root field: ${field}`);
	}
	return errors;
};
