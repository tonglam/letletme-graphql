export type RootFieldAccess =
	| "public"
	| "viewerEntry"
	| "viewerEntryArg"
	| "viewerTournamentMember"
	| "verifiedEntry"
	| "verifiedEntryArg"
	| "tournamentAdmin"
	| "leagueMember"
	| "calcOwnEntries";

export type RootFieldPolicy = Readonly<{
	access: RootFieldAccess;
	arg?: string;
	ownEntryArg?: string;
	tournamentMember?: boolean;
	retainedAdmin?: boolean;
	core: "lightweight" | "full";
}>;

const policy = (
	access: RootFieldAccess,
	options: Partial<Omit<RootFieldPolicy, "access">> = {}
): RootFieldPolicy => ({ access, core: "full", ...options });

const registry = new Map<string, RootFieldPolicy>();

const add = (
	fields: readonly string[],
	access: RootFieldAccess,
	options: Partial<Omit<RootFieldPolicy, "access">> = {}
): void => {
	for (const field of fields) registry.set(field, policy(access, options));
};

add(
	[
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
		"homeMarketDesk",
		"playerStatsBootstrap",
		"playerStatsDesk",
		"gameweekDesk",
		"teamSelectionDesk",
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
		"marketAvailabilityPage",
		"marketLineup",
		"marketOwnershipOverview",
		"marketOwnershipDay",
		"marketSnapshotContext",
		"priceChangeBoard",
		"publicLeagueTrends",
		"publicLeagueSelectionStats",
		"trendCohorts",
		"trendCohortSnapshot",
		"playerDetail",
		"playerStateProfile",
		"miniProgramNotice",
		"briefingWeek",
		"briefingStory",
		"eventOverallResult",
		"entry",
		"entrySnapshot",
		"entryNameUsage",
		"searchEntries",
		"calcLivePointsByEntry",
	],
	"public"
);

add(
	[
		"entryHistory",
		"entryEventResult",
		"entryTransferHistory",
		"entryLive",
		"entryLeagues",
		"entryH2HMatchResults",
		"entryOfficialH2HDesk",
		"entryTournaments",
		"entryParticipatingTournaments",
		"manageableTournaments",
		"entryLiveCompetitionsDesk",
		"tournamentSelectionIndex",
		"tournamentEntrySquads",
		"tournament",
		"tournamentDetailDesk",
		"managedTournament",
		"tournamentEntryRankingSummary",
	],
	"viewerEntryArg",
	{ arg: "entryId" }
);

// Management listings are keyed by the administrator's bound FPL entry, not
// by the currently selected viewer entry. This keeps a Mini Program's
// followed team from becoming an authorization identity for management data.
registry.set("manageableTournaments", policy("verifiedEntryArg", { arg: "entryId" }));

add(
	[
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
		"entryLiveCompetitionBoard",
		"myFplCompetitionSeasonPath",
		"myFplCompetitionSetupStatus",
	],
	"viewerTournamentMember",
	{ arg: "tournamentId" }
);

for (const field of [
	"myFplTeamDesk",
	"myFplTeamGameweek",
	"myFplTeamTransfers",
	"myFplCompetitionsDesk",
]) {
	registry.set(field, policy("viewerEntry"));
}

for (const field of [
	"managedTournament",
	"tournament",
	"tournamentDetailDesk",
	"tournamentEntryRankingSummary",
	"entryLiveCompetitionBoard",
]) {
	const current = registry.get(field);
	if (current) registry.set(field, { ...current, ownEntryArg: "entryId" });
}
registry.set(
	"managedTournament",
	policy("tournamentAdmin", { arg: "tournamentId", ownEntryArg: "entryId" })
);
registry.set(
	"managedTournamentStatus",
	policy("tournamentAdmin", { arg: "tournamentId", ownEntryArg: "entryId" })
);
registry.set("leagueEventResults", policy("leagueMember", { arg: "leagueId" }));
registry.set("calcLivePointsForEntries", policy("calcOwnEntries", { arg: "entryIds" }));
registry.set("homePersonalDesk", policy("viewerEntry"));

for (const field of [
	"tournamentParticipants",
	"tournamentDetailDesk",
	"tournament",
	"entryLiveCompetitionBoard",
]) {
	const current = registry.get(field);
	if (current) registry.set(field, { ...current, retainedAdmin: true, tournamentMember: true });
}

for (const [field, current] of registry) {
	if (current.access === "viewerTournamentMember") {
		registry.set(field, { ...current, tournamentMember: true });
	}
}

const lightweightFields = [
	"event",
	"events",
	"eventFixtures",
	"currentEventInfo",
	"coreEventContext",
	"homePublicBootstrap",
	"homeGameweek",
	"homeMarketPulse",
	"homeMarketDesk",
	"homePersonalDesk",
	"playerStatsBootstrap",
	"playersForPicker",
	"playerStatsDesk",
	"trendCohorts",
	"trendCohortSnapshot",
	"gameweekDesk",
	"teamSelectionDesk",
	"marketSnapshotContext",
	"marketPulse",
	"priceChangeBoard",
	"marketOwnershipOverview",
	"marketOwnershipDay",
	"topTransfersIn",
	"topTransfersOut",
	"playerValueHistory",
	"briefingWeek",
	"briefingStory",
	"entrySnapshot",
	"entryNameUsage",
	"entryTournaments",
	"entryParticipatingTournaments",
	"manageableTournaments",
	"tournament",
	"managedTournament",
	"tournamentParticipants",
	"tournamentEntryIds",
	"tournamentOfficialH2H",
	"tournamentDetailDesk",
	"entryOfficialH2HDesk",
	"managedTournamentStatus",
	"myFplTeamDesk",
	"myFplTeamGameweek",
	"myFplTeamTransfers",
	"myFplCompetitionsDesk",
	"myFplCompetitionBoard",
	"myFplCompetitionSeasonPath",
	"myFplCompetitionSetupStatus",
] as const;
for (const field of lightweightFields) {
	const current = registry.get(field);
	if (current) registry.set(field, { ...current, core: "lightweight" });
}

export const ROOT_FIELD_POLICIES: ReadonlyMap<string, RootFieldPolicy> = registry;
export const LIGHTWEIGHT_CORE_FIELDS: ReadonlySet<string> = new Set(
	[...ROOT_FIELD_POLICIES]
		.filter(([, fieldPolicy]) => fieldPolicy.core === "lightweight")
		.map(([fieldName]) => fieldName)
);

export const getRootFieldPolicy = (fieldName: string): RootFieldPolicy | undefined =>
	ROOT_FIELD_POLICIES.get(fieldName);

export const isGraphQLRootFieldClassified = (fieldName: string): boolean =>
	ROOT_FIELD_POLICIES.has(fieldName);
