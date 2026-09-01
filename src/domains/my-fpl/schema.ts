export const myFplTypeDefs = /* GraphQL */ `
	enum MyFplReviewState {
		PRESEASON
		PENDING
		READY
		EMPTY
		UNAVAILABLE
	}

	enum MyFplTimelineStatus {
		PROVISIONAL
		FINAL
	}

	enum MyFplScoreSource {
		FPL_EVENT_LIVE
		FPL_FINAL_RESULT
	}

	enum MyFplSettlementState {
		PROVISIONAL
		FINALIZING
		FINAL
		DELAYED
	}

	enum MyFplCoverageState {
		COMPLETE
		CORRECTION_PENDING
	}

	enum MyFplTimelinessState {
		CURRENT
		STALE
	}

	type MyFplSnapshotMeta {
		revision: String!
		completeness: DataCompletenessMeta
		eventId: Int!
		snapshotDate: Date!
		sourceCheckedAt: DateTime!
		publishedAt: DateTime!
		settlementState: MyFplSettlementState!
		coverageState: MyFplCoverageState!
		timelinessState: MyFplTimelinessState!
		expectedEntryCount: Int!
		observedEntryCount: Int!
		finalizationStartedAt: DateTime
		finalizationDueAt: DateTime
		scoreSource: MyFplScoreSource!
		livePublicationId: String
		liveRevision: String
		algorithmVersion: String
		sourceMinCheckedAt: DateTime!
		sourceMaxCheckedAt: DateTime!
	}

	type MyFplReviewContext {
		season: String!
		coreRevision: String!
		currentEventId: Int
		nextEventId: Int
		latestFinalizedEventId: Int
		latestPublishedEventId: Int
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

	type MyFplManagerPositionPoints {
		goalkeeper: Int!
		defender: Int!
		midfielder: Int!
		forward: Int!
		assistantManager: Int!
		total: Int!
	}

	type MyFplManagerCaptainReview {
		captainElement: Int
		captainWebName: String
		captainTeamShortName: String
		captainBasePoints: Int!
		captainBlank: Boolean!
		captainContribution: Int!
		viceCaptainElement: Int
		viceCaptainWebName: String
		viceCaptainBasePoints: Int!
		bestSquadElement: Int
		bestSquadWebName: String
		bestSquadPoints: Int!
		regretPoints: Int
	}

	type MyFplManagerAutomaticSubstitution {
		elementIn: Int!
		elementInWebName: String!
		elementOut: Int!
		elementOutWebName: String!
		pointsGained: Int!
	}

	type MyFplManagerGameweekReview {
		formation: String!
		lineupBasePoints: Int!
		bestElevenPoints: Int!
		benchRegretPoints: Int
		positionPoints: MyFplManagerPositionPoints!
		captain: MyFplManagerCaptainReview!
		automaticSubstitutions: [MyFplManagerAutomaticSubstitution!]!
	}

	type MyFplManagerTimelineRow {
		eventId: Int!
		status: MyFplTimelineStatus!
		eventPoints: Int!
		eventRank: Int
		overallPoints: Int!
		overallRank: Int
		overallRankDelta: Int
		eventTransfers: Int!
		eventTransfersCost: Int!
		eventNetPoints: Int!
		eventBenchPoints: Int!
		eventAutoSubPoints: Int!
		eventChip: Chip!
		eventCaptainPoints: Int!
		captainWebName: String
		captainTeamShortName: String
		teamValue: Int
		bank: Int
		review: MyFplManagerGameweekReview!
	}

	type MyFplPastSeason {
		season: String!
		totalPoints: Int!
		overallRank: Int!
	}

	type MyFplManagerPick {
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

	type MyFplManagerGameweekResult {
		eventId: Int!
		eventPoints: Int!
		eventRank: Int
		overallPoints: Int!
		overallRank: Int
		eventTransfers: Int!
		eventTransfersCost: Int!
		eventNetPoints: Int!
		eventBenchPoints: Int!
		eventAutoSubPoints: Int!
		eventChip: Chip!
		eventCaptainPoints: Int!
		playedCaptainWebName: String
		playedCaptainTeamShortName: String
		teamValue: Int
		bank: Int
		picks: [MyFplManagerPick!]!
	}

	type MyFplManagerGameweek {
		state: MyFplReviewState!
		context: MyFplReviewContext!
		eventId: Int!
		entry: MyFplEntryIdentity
		result: MyFplManagerGameweekResult
		review: MyFplManagerGameweekReview
		snapshotMeta: MyFplSnapshotMeta
	}

	type MyFplManagerFormationCount {
		formation: String!
		gameweeks: Int!
	}

	type MyFplManagerChipReview {
		chip: Chip!
		eventId: Int!
		status: MyFplTimelineStatus!
		eventNetPoints: Int!
		otherGameweeksAverageNetPoints: Float
		differenceFromOtherGameweeks: Float
		overallRankDelta: Int
	}

	type MyFplManagerSeasonSummary {
		gameweeksReviewed: Int!
		provisionalGameweeks: Int!
		totalNetPoints: Int!
		averageNetPoints: Float!
		medianNetPoints: Float!
		bestGameweekId: Int
		bestNetPoints: Int
		worstGameweekId: Int
		worstNetPoints: Int
		totalHitPoints: Int!
		hitGameweeks: Int!
		totalBenchPoints: Int!
		averageBenchPoints: Float!
		zeroBenchGameweeks: Int!
		highBenchGameweeks: Int!
		totalAutoSubPoints: Int!
		autoSubGameweeks: Int!
		totalCaptainPoints: Int!
		uniqueCaptains: Int!
		captainBlankGameweeks: Int!
		topCaptainWebName: String
		topCaptainGameweeks: Int!
		topCaptainRate: Float!
		bestOverallRank: Int
		worstOverallRank: Int
		overallRankChange: Int
		currentImprovementStreak: Int!
		longestImprovementStreak: Int!
		formations: [MyFplManagerFormationCount!]!
		positionPoints: MyFplManagerPositionPoints!
		chips: [MyFplManagerChipReview!]!
	}

	type MyFplManagerHoldingPeriod {
		element: Int!
		webName: String!
		teamShortName: String!
		elementTypeName: String!
		startedEventId: Int!
		endedEventId: Int
		gameweeksHeld: Int!
		starts: Int!
		captaincies: Int!
		pointsWhileOwned: Int!
		scoringContribution: Int!
	}

	type MyFplTransferMove {
		eventId: Int!
		elementIn: Int
		elementInWebName: String!
		elementInTypeName: String!
		elementInTeamShortName: String!
		elementInCost: Int!
		elementInPoints: Int
		elementInPlayed: Boolean
		elementOut: Int
		elementOutWebName: String!
		elementOutTypeName: String!
		elementOutTeamShortName: String!
		elementOutCost: Int!
		elementOutPoints: Int
		sameGameweekGain: Int
		threeGameweekGain: Int
		fiveGameweekGain: Int
		evaluatedThroughEventId: Int
		time: DateTime!
	}

	type MyFplTransferGameweek {
		eventId: Int!
		eventTransfers: Int!
		eventTransfersCost: Int!
		transfers: [MyFplTransferMove!]!
	}

	type MyFplManagerReview {
		state: MyFplReviewState!
		context: MyFplReviewContext!
		entry: MyFplEntryIdentity
		throughEventId: Int
		timeline: [MyFplManagerTimelineRow!]!
		summary: MyFplManagerSeasonSummary
		holdings: [MyFplManagerHoldingPeriod!]!
		transfers: [MyFplTransferGameweek!]!
		pastSeasons: [MyFplPastSeason!]!
		pastSeasonsState: MyFplReviewState!
		currentGameweek: MyFplManagerGameweek
		rules: TeamSelectionRules
		snapshotMeta: MyFplSnapshotMeta
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

	"""
	The V2 read-only review center is backed by finalized, revisioned scopes.
	"""
	enum MyTournamentReviewScope {
		ACCESSIBLE
		MANAGED
		ALL
	}

	enum MyTournamentReviewFormat {
		POINTS
		H2H
		KNOCKOUT
	}

	enum MyTournamentReviewState {
		NOT_STARTED
		PENDING
		WAITING_SOURCE
		READY
		DEGRADED
		UNAVAILABLE
	}

	enum MyTournamentReviewSeasonSection {
		POINTS_STANDINGS
		POINTS_TRAJECTORIES
		H2H_STANDINGS
		H2H_FIXTURES
		KNOCKOUT_BRACKET
	}

	type MyTournamentReviewPageInfo {
		hasNextPage: Boolean!
		endCursor: String
	}

	type MyTournamentReviewCatalogEdge {
		cursor: String!
		node: MyTournamentReviewCatalogItem!
	}

	type MyTournamentReviewCatalogConnection {
		state: MyTournamentReviewState!
		asOf: DateTime!
		viewerEntryId: Int
		adminReadAll: Boolean!
		edges: [MyTournamentReviewCatalogEdge!]!
		pageInfo: MyTournamentReviewPageInfo!
	}

	type MyTournamentReviewScopeMeta {
		tournamentId: Int!
		eventId: Int!
		revision: String!
		format: MyTournamentReviewFormat!
		state: MyTournamentReviewState!
		settledAt: DateTime!
		publishedAt: DateTime!
		correctedAt: DateTime
		semanticSha256: String!
		rowCount: Int!
		expectedSubjectCount: Int!
		readySubjectCount: Int!
		notApplicableSubjectCount: Int!
	}

	type MyTournamentReviewCatalogItem {
		tournamentId: Int!
		name: String!
		creator: String!
		leagueId: Int!
		leagueType: String!
		totalTeamNum: Int!
		latestFinalizedEventId: Int
		previousReadyEventId: Int
		setupStatus: String!
		latestFinalizedScope: MyTournamentReviewEventStatus
		phaseSummaries: [MyTournamentReviewPhaseSummary!]!
		state: MyTournamentReviewState!
	}

	type MyTournamentReviewPhaseSummary {
		phaseId: String!
		format: MyTournamentReviewFormat!
		startEventId: Int!
		endEventId: Int
		state: MyTournamentReviewState!
	}

	type MyTournamentReviewPointsRow {
		entryId: Int!
		entryName: String!
		playerName: String!
		applicable: Boolean!
		groupId: Int
		rank: Int
		previousRank: Int
		grossPoints: Int
		transferCost: Int
		netPoints: Int
		tournamentScore: Int
		seasonGrossPoints: Int
		seasonNetPoints: Int
		eventRank: Int
		overallPoints: Int
		overallRank: Int
	}

	type MyTournamentReviewPoints {
		headlineMetric: String!
		grossPointsTotal: Int!
		grossPointsAverage: Float!
		netPointsTotal: Int!
		seasonGrossPointsTotal: Int!
		seasonGrossPointsAverage: Float!
		seasonNetPointsTotal: Int!
		rows: [MyTournamentReviewPointsRow!]!
		nextCursor: String
		hasNextPage: Boolean!
	}

	type MyTournamentReviewH2HSide {
		entryId: Int
		entryName: String!
		isAverage: Boolean!
		grossPoints: Int
		transferCost: Int
		netPoints: Int
		matchPoints: Int
		rank: Int
	}

	type MyTournamentReviewH2HMatch {
		matchId: String!
		groupId: Int!
		home: MyTournamentReviewH2HSide
		away: MyTournamentReviewH2HSide
		isBye: Boolean!
	}

	type MyTournamentReviewH2HStanding {
		groupId: Int!
		entryId: Int!
		entryName: String!
		rank: Int!
		played: Int!
		won: Int!
		drawn: Int!
		lost: Int!
		matchPoints: Int!
		pointsFor: Int!
		pointsAgainst: Int!
	}

	type MyTournamentReviewH2H {
		matches: [MyTournamentReviewH2HMatch!]!
		standings: [MyTournamentReviewH2HStanding!]!
		nextCursor: String
		hasNextPage: Boolean!
	}

	type MyTournamentReviewKnockoutSide {
		entryId: Int!
		entryName: String!
		grossPoints: Int
		transferCost: Int
		netPoints: Int
		goalsScored: Int
		goalsConceded: Int
	}

	type MyTournamentReviewKnockoutMatch {
		round: Int
		name: String
		matchId: Int!
		playAgainstId: Int!
		home: MyTournamentReviewKnockoutSide
		away: MyTournamentReviewKnockoutSide
		winnerEntryId: Int
	}

	type MyTournamentReviewKnockout {
		matches: [MyTournamentReviewKnockoutMatch!]!
		nextCursor: String
		hasNextPage: Boolean!
	}

	type MyTournamentGameweekReview {
		state: MyTournamentReviewState!
		scope: MyTournamentReviewScopeMeta
		payload: MyTournamentReviewPayload
	}

	interface MyTournamentReviewPayload {
		format: MyTournamentReviewFormat!
	}

	type MyTournamentReviewPointsPayload implements MyTournamentReviewPayload {
		format: MyTournamentReviewFormat!
		points: MyTournamentReviewPoints!
	}

	type MyTournamentReviewH2HPayload implements MyTournamentReviewPayload {
		format: MyTournamentReviewFormat!
		h2h: MyTournamentReviewH2H!
	}

	type MyTournamentReviewKnockoutPayload implements MyTournamentReviewPayload {
		format: MyTournamentReviewFormat!
		knockout: MyTournamentReviewKnockout!
	}

	type MyTournamentSeasonReview {
		state: MyTournamentReviewState!
		tournamentId: Int!
		throughEventId: Int!
		latestFinalizedEventId: Int
		phases: [MyTournamentReviewPhase!]!
	}

	type MyTournamentReviewPhase {
		phaseId: String!
		format: MyTournamentReviewFormat!
		startEventId: Int!
		endEventId: Int!
		state: MyTournamentReviewState!
		settledAt: DateTime
		publishedAt: DateTime
		correctedAt: DateTime
		revision: String
		semanticSha256: String
	}

	type MyTournamentSeasonSection {
		state: MyTournamentReviewState!
		tournamentId: Int!
		throughEventId: Int!
		phaseId: String!
		section: MyTournamentReviewSeasonSection!
		revision: String!
		semanticSha256: String!
		points: MyTournamentReviewPoints
		h2h: MyTournamentReviewH2H
		knockout: MyTournamentReviewKnockout
		pageInfo: MyTournamentReviewPageInfo!
	}

	type MyTournamentReviewEventStatus {
		eventId: Int!
		format: MyTournamentReviewFormat!
		state: MyTournamentReviewState!
		nextAttemptAt: DateTime
		executionAttempts: Int!
		sourceRechecks: Int!
		degradedAt: DateTime
		revision: String
		publishedAt: DateTime
	}

	type MyTournamentReviewStatus {
		tournamentId: Int!
		latestFinalizedEventId: Int
		events: [MyTournamentReviewEventStatus!]!
	}

	extend type Query {
		myFplManagerReview(snapshotRevision: String): MyFplManagerReview!
		myFplManagerGameweek(eventId: Int!, snapshotRevision: String): MyFplManagerGameweek!

		myFplCompetitionSetupStatus(tournamentId: Int!): MyFplCompetitionSetupStatus!

		myTournamentReviewCatalog(
			scope: MyTournamentReviewScope!
			first: Int = 50
			after: String
			search: String
		): MyTournamentReviewCatalogConnection!

		myTournamentGameweekReview(
			tournamentId: Int!
			eventId: Int!
			first: Int = 50
			after: String
			revision: String
		): MyTournamentGameweekReview!

		myTournamentSeasonReview(tournamentId: Int!, throughEventId: Int!): MyTournamentSeasonReview!

		myTournamentSeasonReviewSection(
			tournamentId: Int!
			throughEventId: Int!
			phaseId: String!
			section: MyTournamentReviewSeasonSection!
			first: Int = 50
			after: String
			revision: String!
			semanticSha256: String!
		): MyTournamentSeasonSection!

		myTournamentReviewStatus(tournamentId: Int!): MyTournamentReviewStatus!
	}
`;
