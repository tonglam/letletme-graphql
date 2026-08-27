import { ROOT_FIELD_POLICIES, type RootFieldAccess } from "./root-field-policy";
import { ROOT_RATE_LIMIT_FLOORS } from "./limits";

export type GraphQLDomainManifestEntry = Readonly<{
	name: string;
	typeDefsModule: string;
	resolversModule: string;
	rootFields: readonly string[];
	auth: readonly RootFieldAccess[];
	rateLimitBudget: Readonly<Record<string, number>>;
}>;

const domain = (
	name: string,
	moduleName: string,
	rootFields: readonly string[],
	moduleRoot = `src/domains/${moduleName}`,
	moduleFiles: Readonly<{ typeDefs: string; resolvers: string }> = {
		typeDefs: "schema.ts",
		resolvers: "resolvers.ts",
	}
): GraphQLDomainManifestEntry => {
	const auth = Array.from(
		new Set(rootFields.map((field) => ROOT_FIELD_POLICIES.get(field)?.access).filter(Boolean))
	) as RootFieldAccess[];
	const rateLimitBudget = Object.fromEntries(
		rootFields.map((field) => [field, ROOT_RATE_LIMIT_FLOORS.get(field) ?? 0])
	);
	return {
		name,
		typeDefsModule: `${moduleRoot}/${moduleFiles.typeDefs}`,
		resolversModule: `${moduleRoot}/${moduleFiles.resolvers}`,
		rootFields,
		auth,
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
		{ typeDefs: "base-schema.ts", resolvers: "base-schema.ts" }
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

export const validateGraphQLDomainManifest = (): readonly string[] => {
	const errors: string[] = [];
	const seen = new Set<string>();
	for (const entry of GRAPHQL_DOMAIN_MANIFEST) {
		for (const field of entry.rootFields) {
			if (seen.has(field)) errors.push(`duplicate root field: ${field}`);
			seen.add(field);
			if (!ROOT_FIELD_POLICIES.has(field)) errors.push(`unclassified root field: ${field}`);
			if (!(field in entry.rateLimitBudget)) errors.push(`missing rate-limit budget: ${field}`);
		}
	}
	for (const field of ROOT_FIELD_POLICIES.keys()) {
		if (!seen.has(field)) errors.push(`unassigned root field: ${field}`);
	}
	return errors;
};
