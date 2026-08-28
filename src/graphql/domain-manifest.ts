import type { GraphQLSchema } from "graphql";
import {
	ROOT_FIELD_CONDITIONAL_ACCESS,
	ROOT_FIELD_POLICIES,
	type RootFieldAccess,
} from "./root-field-policy";
import { effectiveRootRateLimitFloor } from "./limits";

export type GraphQLConditionalAuth = Readonly<{
	field: string;
	argument: string;
	equals: string | number | boolean;
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
		"entryTournaments",
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

export const validateGraphQLDomainManifest = (schema: GraphQLSchema): readonly string[] => {
	const errors: string[] = [];
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
