export const myFplTypeDefs = /* GraphQL */ `
	enum MyFplReviewState {
		PRESEASON
		PENDING
		READY
		EMPTY
		UNAVAILABLE
	}

	type MyFplReviewContext {
		season: String!
		coreRevision: String!
		currentEventId: Int
		nextEventId: Int
		latestFinalizedEventId: Int
	}

	type MyFplEntryIdentity {
		id: Int!
		entryName: String!
		playerName: String!
		region: String
		startedEvent: Int
		overallPoints: Int
		overallRank: Int
		bank: Int
		teamValue: Int
		totalTransfers: Int
	}

	type MyFplTeamHistoryRow {
		eventId: Int!
		eventPoints: Int!
		eventRank: Int
		overallPoints: Int!
		overallRank: Int!
		eventTransfers: Int!
		eventTransfersCost: Int!
		eventNetPoints: Int!
		eventBenchPoints: Int!
		eventChip: Chip!
		eventCaptainPoints: Int!
		captainWebName: String
		captainTeamShortName: String
		teamValue: Int
		bank: Int
	}

	type MyFplPastSeason {
		season: String!
		totalPoints: Int!
		overallRank: Int!
	}

	type MyFplTeamPick {
		element: Int!
		position: Int!
		webName: String!
		teamShortName: String!
		teamName: String!
		elementTypeName: String!
		isCaptain: Boolean!
		isViceCaptain: Boolean!
		multiplier: Int!
		totalPoints: Int!
		minutes: Int!
		goalsScored: Int!
		assists: Int!
		cleanSheets: Int!
		goalsConceded: Int!
		yellowCards: Int!
		redCards: Int!
		saves: Int!
		bonus: Int!
		bps: Int!
		againstShortName: String!
		wasHome: String!
		score: String!
		fixtureCount: Int!
		bgw: Boolean!
		dgw: Boolean!
		isPlayed: Boolean!
		autoSub: Boolean!
		expectedGoals: Float
		expectedAssists: Float
		expectedGoalInvolvements: Float
		expectedGoalsConceded: Float
	}

	type MyFplTeamGameweekResult {
		eventId: Int!
		eventPoints: Int!
		overallPoints: Int!
		overallRank: Int!
		eventTransfers: Int!
		eventTransfersCost: Int!
		eventNetPoints: Int!
		eventBenchPoints: Int!
		eventChip: Chip!
		eventCaptainPoints: Int!
		playedCaptainWebName: String
		teamValue: Int
		bank: Int
		picks: [MyFplTeamPick!]!
	}

	type MyFplTeamGameweek {
		state: MyFplReviewState!
		context: MyFplReviewContext!
		eventId: Int!
		entry: MyFplEntryIdentity
		result: MyFplTeamGameweekResult
	}

	type MyFplTeamDesk {
		state: MyFplReviewState!
		context: MyFplReviewContext!
		entry: MyFplEntryIdentity
		history: [MyFplTeamHistoryRow!]!
		pastSeasons: [MyFplPastSeason!]!
		pastSeasonsState: MyFplReviewState!
		selectedEventId: Int
		gameweek: MyFplTeamGameweek
	}

	type MyFplTransferMove {
		eventId: Int!
		elementInWebName: String!
		elementInTypeName: String!
		elementInTeamShortName: String!
		elementInCost: Int!
		elementOutWebName: String!
		elementOutTypeName: String!
		elementOutTeamShortName: String!
		elementOutCost: Int!
		time: DateTime!
	}

	type MyFplTransferGameweek {
		eventId: Int!
		eventTransfers: Int!
		eventTransfersCost: Int!
		transfers: [MyFplTransferMove!]!
	}

	type MyFplTeamTransfers {
		state: MyFplReviewState!
		context: MyFplReviewContext!
		gameweeks: [MyFplTransferGameweek!]!
	}

	type MyFplCompetitionBoardRow {
		eventId: Int!
		groupId: Int
		entryId: Int!
		entryName: String
		playerName: String
		rank: Int
		previousRank: Int
		eventPoints: Int
		eventCost: Int
		eventNetPoints: Int
		eventRank: Int
		overallPoints: Int
		overallRank: Int
		eventChip: Chip
		captainId: Int
		captainWebName: String
		captainTeamShortName: String
		captainPoints: Int
		teamValue: Int
		bank: Int
	}

	type MyFplCompetitionBoardPage {
		state: MyFplReviewState!
		eventId: Int!
		page: Int!
		pageSize: Int!
		totalRows: Int!
		totalPages: Int!
		fieldSize: Int!
		rows: [MyFplCompetitionBoardRow!]!
		viewerRow: MyFplCompetitionBoardRow
	}

	type MyFplCompetitionMetric {
		key: TournamentSeasonMetricKey!
		leaderValue: Float
		leaderEntryId: Int
		leaderEntryName: String
		leaderPlayerName: String
		averageValue: Float
		higherIsBetter: Boolean!
	}

	type MyFplCompetitionViewerSummary {
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
		overallPoints: Int
		leaderOverallPoints: Int
		gapToLeader: Int
		pointsBehindNext: Int
		pointsAheadOfPrev: Int
	}

	type MyFplCompetitionPerformance {
		entryId: Int!
		entryName: String
		playerName: String
		eventPoints: Int!
		eventNetPoints: Int!
		rank: Int
		previousRank: Int
		captainId: Int
		captainWebName: String
		captainTeamShortName: String
		captainPoints: Int
	}

	type MyFplCompetitionDistribution {
		key: String!
		label: String!
		teamShortName: String
		count: Int!
		percentage: Float!
		averagePoints: Float!
	}

	type MyFplCompetitionAggregate {
		eventId: Int!
		entryCount: Int!
		leaderOverallPoints: Int
		secondOverallPoints: Int
		gapFirstSecond: Int
		averageOverallPoints: Int
		metrics: [MyFplCompetitionMetric!]!
		viewer: MyFplCompetitionViewerSummary
		topPerformers: [MyFplCompetitionPerformance!]!
		risers: [MyFplCompetitionPerformance!]!
		fallers: [MyFplCompetitionPerformance!]!
		captainDistribution: [MyFplCompetitionDistribution!]!
		chipDistribution: [MyFplCompetitionDistribution!]!
	}

	type MyFplCompetitionsDesk {
		state: MyFplReviewState!
		context: MyFplReviewContext!
		tournaments: [TournamentInfo!]!
		selectedTournamentId: Int
		selectedTournament: TournamentInfo
		eventId: Int
		board: MyFplCompetitionBoardPage
		aggregate: MyFplCompetitionAggregate
	}

	type MyFplCompetitionSeasonPathPoint {
		gameweek: Int!
		tournamentRank: Int
		gapToLeader: Int
		pointsVsAverage: Float
		fieldSize: Int!
		overallPoints: Int
		leaderOverallPoints: Int
		averageOverallPoints: Float
	}

	type MyFplCompetitionSeasonPath {
		state: MyFplReviewState!
		context: MyFplReviewContext!
		tournamentId: Int!
		throughEventId: Int!
		points: [MyFplCompetitionSeasonPathPoint!]!
	}

	type MyFplCompetitionSetupStatus {
		tournamentId: Int!
		setupStatus: TournamentSetupStatus!
		setupPhase: TournamentSetupPhase!
		setupCompletedUnits: Int!
		setupTotalUnits: Int!
		setupProgressUpdatedAt: DateTime
		standingsReadyAt: DateTime
		insightsReadyAt: DateTime
		setupHasWarnings: Boolean! @deprecated(reason: "Use insightsReadyAt")
		ready: Boolean!
	}

	extend type Query {
		myFplTeamDesk(eventId: Int): MyFplTeamDesk!
		myFplTeamGameweek(eventId: Int!): MyFplTeamGameweek!
		myFplTeamTransfers: MyFplTeamTransfers!

		myFplCompetitionsDesk(tournamentId: Int, eventId: Int): MyFplCompetitionsDesk!

		myFplCompetitionBoard(
			tournamentId: Int!
			eventId: Int!
			page: Int = 1
			pageSize: Int = 100
			search: String
		): MyFplCompetitionBoardPage!

		myFplCompetitionSeasonPath(
			tournamentId: Int!
			throughEventId: Int!
		): MyFplCompetitionSeasonPath!

		myFplCompetitionSetupStatus(tournamentId: Int!): MyFplCompetitionSetupStatus!
	}
`;
