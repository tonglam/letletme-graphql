export const tournamentsTypeDefs = /* GraphQL */ `
	enum TournamentMode {
		NORMAL
	}

	enum GroupMode {
		NO_GROUP
		POINTS_RACES
		BATTLE_RACES
	}

	enum KnockoutMode {
		NO_KNOCKOUT
		SINGLE_ELIMINATION
		DOUBLE_ELIMINATION
		HEAD_TO_HEAD
	}

	enum TournamentState {
		ACTIVE
		INACTIVE
		FINISHED
	}

	enum TournamentSetupStatus {
		PENDING
		PROCESSING
		READY
		FAILED
	}

	enum TournamentSetupPhase {
		QUEUED
		SYNCING_ENTRIES
		BUILDING_STRUCTURE
		CALCULATING_STANDINGS
		ENRICHING_HISTORY
		FINALIZING
		READY
		FAILED
	}

	enum TournamentSetupProgressMode {
		DETERMINATE
		INDETERMINATE
	}

	enum TournamentSetupWarningCategory {
		PROFILES
		INSIGHTS
		RESULTS
	}

	enum TournamentSetupIssueSeverity {
		WARNING
		BLOCKING
	}

	type TournamentSetupWarningSummary {
		category: TournamentSetupWarningCategory!
		affectedCount: Int!
		repairExhausted: Boolean!
	}

	type TournamentSetupIssueDiagnostic {
		issueKey: String!
		code: String!
		diagnosticCode: String
		category: TournamentSetupWarningCategory!
		severity: TournamentSetupIssueSeverity!
		eventId: Int
		affectedEntryIds: [Int!]!
		affectedCount: Int!
		repairAttempts: Int!
		nextRepairAt: DateTime
		repairExhausted: Boolean!
	}

	enum TournamentRosterMode {
		SNAPSHOT
		OFFICIAL_SYNC
	}

	enum TournamentDetailKind {
		SETUP
		OFFICIAL_H2H
		LIVE_POINTS
	}

	enum TournamentDetailSection {
		PARTICIPANTS
	}

	type TournamentInfo {
		id: Int!
		name: String!
		creator: String!
		adminEntryId: Int!
		leagueId: Int!
		leagueType: LeagueType!
		sourceLeagueName: String
		rosterMode: TournamentRosterMode!
		rosterSyncStatus: TournamentSetupStatus
		rosterLastSyncedAt: DateTime
		officialScheduleHash: String
		officialScheduleSyncedAt: DateTime
		officialScheduleLockedAt: DateTime
		totalTeamNum: Int!
		tournamentMode: TournamentMode!
		groupMode: GroupMode
		groupTeamNum: Int
		groupNum: Int
		groupStartedEventId: Int
		groupEndedEventId: Int
		groupAutoAverages: Boolean!
		groupRounds: Int
		groupPlayAgainstNum: Int
		groupQualifyNum: Int
		knockoutMode: KnockoutMode
		knockoutTeamNum: Int
		knockoutRounds: Int
		knockoutEventNum: Int
		knockoutStartedEventId: Int
		knockoutEndedEventId: Int
		knockoutPlayAgainstNum: Int
		state: TournamentState!
		setupStatus: TournamentSetupStatus!
		setupPhase: TournamentSetupPhase!
		setupCompletedUnits: Int!
		setupTotalUnits: Int!
		setupProgressUpdatedAt: DateTime
		setupProgressMode: TournamentSetupProgressMode!
		setupAttempt: Int!
		setupMaxAttempts: Int!
		nextRetryAt: DateTime
		standingsReadyAt: DateTime
		profilesReadyAt: DateTime
		insightsReadyAt: DateTime
		setupHasWarnings: Boolean! @deprecated(reason: "Use warningSummaries and capability timestamps")
		warningSummaries: [TournamentSetupWarningSummary!]!
		setupStartedAt: DateTime
		setupFinishedAt: DateTime
		createdAt: DateTime!
		updatedAt: DateTime!
	}

	type TournamentParticipant {
		entryId: Int!
		entryName: String
		playerName: String
	}

	type TournamentEventContext {
		season: String!
		coreRevision: String!
		activeEventId: Int
		requestedEventId: Int!
	}

	type TournamentSetupDesk {
		status: TournamentSetupStatus!
		phase: TournamentSetupPhase!
		completedUnits: Int!
		totalUnits: Int!
		hasWarnings: Boolean!
		progressMode: TournamentSetupProgressMode!
		attempt: Int!
		maxAttempts: Int!
		nextRetryAt: DateTime
		warningSummaries: [TournamentSetupWarningSummary!]!
	}

	type TournamentOfficialH2HBoard {
		eventId: Int!
		awaitingSchedule: Boolean!
		scoreSource: OfficialH2HScoreSource!
		scoreRevision: String
		scoreCheckedAt: DateTime
		standings: [OfficialH2HStanding!]!
		matches: [OfficialH2HMatch!]!
	}

	type TournamentLiveBoard {
		eventId: Int!
		revision: String
		state: LiveSnapshotState!
		partial: Boolean!
		failedEntryIds: [Int!]!
		totalEntries: Int!
		rows: [LiveCalcData!]!
	}

	type TournamentDetailDesk {
		revision: String!
		kind: TournamentDetailKind!
		context: TournamentEventContext!
		tournament: TournamentInfo!
		viewerEntryId: Int!
		canManage: Boolean!
		participants: [TournamentParticipant!]!
		unavailableSections: [TournamentDetailSection!]!
		setup: TournamentSetupDesk
		officialH2H: TournamentOfficialH2HBoard
		live: TournamentLiveBoard
	}

	type ManagedTournamentStatus {
		revision: String!
		state: TournamentState!
		setupStatus: TournamentSetupStatus!
		setupPhase: TournamentSetupPhase!
		rosterSyncStatus: TournamentSetupStatus
		setupCompletedUnits: Int!
		setupTotalUnits: Int!
		setupProgressMode: TournamentSetupProgressMode!
		setupAttempt: Int!
		setupMaxAttempts: Int!
		nextRetryAt: DateTime
		standingsReadyAt: DateTime
		profilesReadyAt: DateTime
		insightsReadyAt: DateTime
		setupHasWarnings: Boolean! @deprecated(reason: "Use warningSummaries and capability timestamps")
		warningSummaries: [TournamentSetupWarningSummary!]!
		issues: [TournamentSetupIssueDiagnostic!]!
		updatedAt: DateTime!
	}

	type TournamentEventResult {
		tournament: TournamentInfo!
		event: Event
		captain: Player
		groupId: Int!
		entryId: Int!
		entryName: String
		playerName: String
		eventGroupRank: Int
		eventPoints: Int
		eventCost: Int
		eventNetPoints: Int
		eventRank: Int
		overallPoints: Int
		overallRank: Int
		eventChip: Chip
		captainId: Int
		captainPoints: Int
		teamValue: Int
		bank: Int
	}

	type TournamentEntryRankingSummary {
		entryId: Int!
		overallRank: Int
		tournamentOverallRank: Int
		teamValue: Int
		tournamentTeamValueRank: Int
		transfersNum: Int
		tournamentTransfersRank: Int
		totalCosts: Int
		tournamentCostsRank: Int
		totalBenchPoints: Int
		tournamentBenchPointsRank: Int
		autoSubPoints: Int
		tournamentAutoSubRank: Int
		"""
		FPL cumulative total points for this entry as of eventId.
		"""
		overallPoints: Int
		"""
		Leader's cumulative total points in the tournament as of eventId.
		"""
		leaderOverallPoints: Int
		"""
		Points behind the tournament leader (0 if leading).
		"""
		gapToLeader: Int
		"""
		Points behind the entry immediately above (0 if rank 1).
		"""
		pointsBehindNext: Int
		"""
		Points ahead of the entry immediately below (0 if last).
		"""
		pointsAheadOfPrev: Int
	}

	"""
	One row in the season (as-of event) tournament table.
	"""
	type TournamentSeasonStandingRow {
		entryId: Int!
		rank: Int
		entryName: String
		playerName: String
		overallPoints: Int
		"""
		Global FPL overall rank as of this event (not tournament rank).
		"""
		overallRank: Int
		"""
		Team value in 0.1m FPL units as of this event.
		"""
		teamValue: Int
	}

	"""
	Main tournament metrics used for field leadership / averages.
	"""
	enum TournamentSeasonMetricKey {
		OVERALL_POINTS
		TEAM_VALUE
		TRANSFERS
		TOTAL_COSTS
		BENCH_POINTS
		AUTO_SUB_POINTS
	}

	"""
	Field-level leader + average for one season metric (as-of event).
	Leader is rank-1 for that metric inside the tournament (not always max raw value).
	"""
	type TournamentSeasonMetric {
		key: TournamentSeasonMetricKey!
		leaderValue: Float
		leaderEntryId: Int
		leaderEntryName: String
		leaderPlayerName: String
		averageValue: Float
		"""
		True if higher raw values rank better (points, team value, bench, auto-sub).
		"""
		higherIsBetter: Boolean!
	}

	"""
	Tournament-level season snapshot (dimension A): field size, leader/average points,
	metric leadership board, and cumulative standings as of a given event. POINTS_RACES only.
	"""
	type TournamentSeasonSnapshot {
		asOfEventId: Int!
		entryCount: Int!
		leaderOverallPoints: Int
		secondOverallPoints: Int
		gapFirstSecond: Int
		averageOverallPoints: Int
		"""
		Leaders + averages for overall points, team value, transfers, costs, bench, auto-sub.
		"""
		metrics: [TournamentSeasonMetric!]!
		standings: [TournamentSeasonStandingRow!]!
	}

	type TournamentBattleGroupResult {
		tournament: TournamentInfo!
		event: Event
		matchId: Int!
		groupId: Int!
		homeEntryId: Int!
		homeEntryName: String
		homePlayerName: String
		homeNetPoints: Int
		"""
		Rank within the H2H battle group (tiebroken by FPL overall rank). Not global FPL rank.
		"""
		homeRank: Int
		"""
		H2H match points: 3 = win, 1 = draw, 0 = loss. Sums to 3 with awayMatchPoints when both non-null.
		"""
		homeMatchPoints: Int
		awayEntryId: Int!
		awayEntryName: String
		awayPlayerName: String
		awayNetPoints: Int
		"""
		Rank within the H2H battle group (tiebroken by FPL overall rank). Not global FPL rank.
		"""
		awayRank: Int
		awayMatchPoints: Int
	}

	type EntryH2HMatchResult {
		tournament: TournamentInfo!
		event: Event
		matchId: Int!
		groupId: Int!
		entryId: Int!
		entryName: String
		playerName: String
		entryNetPoints: Int
		"""
		Rank within the H2H battle group. Not global FPL rank.
		"""
		entryRank: Int
		"""
		H2H match points for the queried entry: 3 = win, 1 = draw, 0 = loss.
		"""
		entryMatchPoints: Int
		entryEventPoints: Int
		entryTransferCost: Int
		entryOverallRank: Int
		entryChip: Chip
		opponentEntryId: Int!
		opponentEntryName: String
		opponentPlayerName: String
		opponentNetPoints: Int
		"""
		Rank within the H2H battle group. Not global FPL rank.
		"""
		opponentRank: Int
		opponentMatchPoints: Int
		opponentEventPoints: Int
		opponentTransferCost: Int
		opponentOverallRank: Int
		opponentChip: Chip
	}

	enum OfficialH2HMatchPhase {
		REGULAR
		KNOCKOUT
	}

	enum OfficialH2HScoreSource {
		FPL_EVENT_LIVE
		FPL_H2H_FINAL
		UNAVAILABLE
	}

	type OfficialH2HStanding {
		entryId: Int!
		entryName: String
		playerName: String
		rank: Int
		matchPoints: Int!
		played: Int!
		won: Int!
		drawn: Int!
		lost: Int!
		pointsFor: Int!
	}

	type OfficialH2HMatchSide {
		entryId: Int
		entryName: String!
		playerName: String
		isAverage: Boolean!
		points: Int
		matchPoints: Int
	}

	type OfficialH2HMatch {
		officialMatchId: Int!
		eventId: Int!
		sourceOrder: Int!
		phase: OfficialH2HMatchPhase!
		knockoutName: String
		isBye: Boolean!
		home: OfficialH2HMatchSide!
		away: OfficialH2HMatchSide!
		winnerEntryId: Int
		tiebreak: String
		sourceCheckedAt: DateTime
	}

	type TournamentOfficialH2H {
		tournament: TournamentInfo!
		eventId: Int!
		awaitingSchedule: Boolean!
		scoreSource: OfficialH2HScoreSource!
		scoreRevision: String
		scoreCheckedAt: DateTime
		standings: [OfficialH2HStanding!]!
		matches: [OfficialH2HMatch!]!
	}

	type EntryOfficialH2HDeskItem {
		tournamentId: Int!
		tournamentName: String!
		totalTeams: Int!
		eventId: Int!
		awaitingSchedule: Boolean!
		isLive: Boolean!
		isFinal: Boolean!
		scoreSource: OfficialH2HScoreSource!
		scoreRevision: String
		scoreCheckedAt: DateTime
		rank: Int
		lastRank: Int
		matchPoints: Int!
		match: OfficialH2HMatch
		matches: [OfficialH2HMatch!]!
	}

	extend type Query {
		entryTournaments(entryId: Int!): [TournamentInfo!]!
		tournament(tournamentId: Int!, entryId: Int!): TournamentInfo
		managedTournament(tournamentId: Int!, entryId: Int!): TournamentInfo
		tournamentParticipants(tournamentId: Int!): [TournamentParticipant!]!
		tournamentEntryIds(tournamentId: Int!): [Int!]!
		tournamentEventResults(
			tournamentId: Int!
			eventId: Int!
			limit: Int
			offset: Int
		): [TournamentEventResult!]!
		tournamentEntryRankingSummary(
			tournamentId: Int!
			eventId: Int!
			entryId: Int!
		): TournamentEntryRankingSummary!
		"""
		Season field overview for a tournament as of eventId (standings + aggregates).
		POINTS_RACES only; empty standings when unsupported or no data.
		"""
		tournamentSeasonSnapshot(tournamentId: Int!, eventId: Int!): TournamentSeasonSnapshot!
		tournamentBattleGroupResults(tournamentId: Int!, eventId: Int!): [TournamentBattleGroupResult!]!
		entryH2HMatchResults(entryId: Int!): [EntryH2HMatchResult!]!
		tournamentOfficialH2H(tournamentId: Int!, eventId: Int!): TournamentOfficialH2H!
		entryOfficialH2HDesk(entryId: Int!): [EntryOfficialH2HDeskItem!]!
		tournamentDetailDesk(tournamentId: Int!, entryId: Int!, eventId: Int): TournamentDetailDesk
		managedTournamentStatus(tournamentId: Int!, entryId: Int!): ManagedTournamentStatus
	}
`;
