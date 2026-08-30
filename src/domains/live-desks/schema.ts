export const liveDesksTypeDefs = /* GraphQL */ `
	input LivePublicationRefInput {
		season: String!
		eventId: Int!
		scoreCoreRevision: String!
	}

	enum LiveLifecycleState {
		PRE_DEADLINE
		PICKS_WAIT
		PICKS_PROBE
		PICKS_SYNC
		LIVE_ACTIVE
		BETWEEN_FIXTURES
		DAY_SETTLING
		GW_REVIEW
		FINALIZED
	}

	enum LiveSnapshotSource {
		REDIS_CURRENT
		REDIS_PREVIOUS
		POSTGRES_CHECKPOINT
		PROCESS_LKG
		FINAL_RESULT
		UNAVAILABLE
	}

	enum LiveWindowState {
		PRESEASON
		PRE_DEADLINE
		LIVE_ACTIVE
		DAY_SETTLING
		BETWEEN_FIXTURES
		GW_REVIEW
		FINALIZED
		BETWEEN_GAMEWEEKS
		OFFSEASON
	}

	enum LiveDataAvailability {
		FRESH
		STALE
		DEGRADED
		FINAL
		UNAVAILABLE
	}

	enum LiveAnchorMode {
		UPCOMING
		CURRENT
		PREVIOUS_FINAL
		OFFSEASON
	}

	type LiveContext {
		season: String!
		coreRevision: String!
		currentEventId: Int
		nextEventId: Int
		anchorEventId: Int
		latestFinalizedEventId: Int
		scoreCoreRevision: String
		state: LiveLifecycleState!
		windowState: LiveWindowState!
		producerState: LiveLifecycleState!
		anchorMode: LiveAnchorMode!
		dataAvailability: LiveDataAvailability!
		sourceCheckedAt: DateTime
		publishedAt: DateTime
		source: LiveSnapshotSource
		stale: Boolean!
		nextRefreshAt: DateTime
		revisions: LiveRevisionVector!
		times: LiveTimes!
		delivery: LiveDelivery!
	}

	type LiveMatchSummary {
		fixtureId: Int!
		eventId: Int!
		homeTeamId: Int!
		homeTeamName: String!
		awayTeamId: Int!
		awayTeamName: String!
		homeScore: Int
		awayScore: Int
		kickoffTime: DateTime
		minutes: Int!
		started: Boolean!
		finished: Boolean!
		finishedProvisional: Boolean!
	}

	type LiveMatchdayDesk {
		season: String!
		eventId: Int!
		scoreCoreRevision: String!
		state: LiveSnapshotState!
		windowState: LiveWindowState!
		dataAvailability: LiveDataAvailability!
		sourceCheckedAt: DateTime!
		publishedAt: DateTime!
		source: LiveSnapshotSource!
		stale: Boolean!
		nextRefreshAt: DateTime
		revisions: LiveRevisionVector!
		times: LiveTimes!
		delivery: LiveDelivery!
		matches: [LiveMatchSummary!]!
		highlights: [LivePerformance!]!
	}

	type LiveFixturePlayers {
		season: String!
		eventId: Int!
		scoreCoreRevision: String!
		fixtureId: Int!
		players: [LivePerformance!]!
	}

	type EntryLiveCompetitionsDesk {
		season: String!
		eventId: Int!
		scoreCoreRevision: String
		state: LiveSnapshotState!
		windowState: LiveWindowState!
		dataAvailability: LiveDataAvailability!
		nextRefreshAt: DateTime
		tournaments: [TournamentInfo!]!
		selectedTournamentId: Int
		board: [LiveCalcData!]!
		officialCoverage: Float!
		revisions: LiveRevisionVector
		times: LiveTimes
		delivery: LiveDelivery
		unavailableEntryIds: [Int!]!
		partial: Boolean!
		failedEntryIds: [Int!]!
		totalEntries: Int!
	}

	enum EntryLiveCompetitionBoardSort {
		EVENT_POINTS
		NET_EVENT_POINTS
		TRANSFER_COST
		PLAYED
		TOTAL_POINTS
		TEAM_VALUE
		RANK
		ENTRY_NAME
	}

	enum EntryLiveCompetitionBoardSortDirection {
		ASC
		DESC
	}

	enum EntryLiveCompetitionPickScope {
		ANY
		STARTER
		BENCH
	}

	enum EntryLiveCompetitionCaptainMode {
		ANY
		CAPTAIN
		VICE
	}

	enum EntryLiveCompetitionBoardCoverageState {
		WARMING
		COMPLETE
		PARTIAL
		UNAVAILABLE
	}

	enum EntryLiveCompetitionRankScope {
		FULL_FIELD
		AVAILABLE_ROWS
	}

	input EntryLiveCompetitionOwnershipFilterInput {
		playerIds: [Int!]!
		scope: EntryLiveCompetitionPickScope = ANY
		captainMode: EntryLiveCompetitionCaptainMode = ANY
	}

	input EntryLiveCompetitionTeamCountRuleInput {
		teamId: Int!
		exactCount: Int!
		scope: EntryLiveCompetitionPickScope = ANY
	}

	type EntryLiveCompetitionBoardRow {
		entry: Int!
		entryName: String!
		playerName: String!
		rank: Int!
		overallRank: Int
		teamValue: Float!
		chip: String!
		transferCost: Int!
		played: Int!
		toPlay: Int!
		captainId: Int!
		captainName: String!
		captainPoints: Int!
		score: LiveScore!
	}

	type EntryLiveCompetitionBoardPage {
		season: String!
		eventId: Int!
		tournamentId: Int!
		boardRevision: String!
		scoreCoreRevision: String
		dataAvailability: LiveDataAvailability!
		revisions: LiveRevisionVector!
		times: LiveTimes!
		delivery: LiveDelivery!
		coverageState: EntryLiveCompetitionBoardCoverageState!
		rankScope: EntryLiveCompetitionRankScope!
		computedEntries: Int!
		deferredEntryCount: Int!
		failedEntryCount: Int!
		unavailableEntryCount: Int!
		officialCoverage: Float!
		unavailableEntryIds: [Int!]!
		failedEntryIds: [Int!]!
		partial: Boolean!
		totalEntries: Int!
		filteredEntries: Int!
		page: Int!
		pageSize: Int!
		hasMore: Boolean!
		highestEventPoints: Int
		averageEventPoints: Float
		rows: [EntryLiveCompetitionBoardRow!]!
		viewerRow: EntryLiveCompetitionBoardRow
	}

	type TournamentSelectionIndexRow {
		playerId: Int!
		playerName: String!
		teamId: Int!
		teamName: String!
		teamShortName: String!
		position: Position!
		count: Int!
		percentage: Float!
	}

	type TournamentSelectionIndex {
		tournamentId: Int!
		eventId: Int!
		scoreCoreRevision: String!
		rows: [TournamentSelectionIndexRow!]!
	}

	type TournamentEntrySquads {
		tournamentId: Int!
		eventId: Int!
		scoreCoreRevision: String!
		state: LiveSnapshotState!
		entries: [LiveCalcData!]!
	}

	extend type Query {
		liveContext: LiveContext!
		liveMatchdayDesk(ref: LivePublicationRefInput): LiveMatchdayDesk!
		liveFixturePlayers(ref: LivePublicationRefInput!, fixtureId: Int!): LiveFixturePlayers!
		entryLiveCompetitionsDesk(
			entryId: Int!
			selectedTournamentId: Int
			ref: LivePublicationRefInput
		): EntryLiveCompetitionsDesk!
		entryLiveCompetitionBoard(
			entryId: Int!
			tournamentId: Int!
			eventId: Int!
			ref: LivePublicationRefInput
			page: Int = 1
			pageSize: Int = 20
			sort: EntryLiveCompetitionBoardSort = EVENT_POINTS
			direction: EntryLiveCompetitionBoardSortDirection = DESC
			search: String
			chips: [String!]
			captainPlayerIds: [Int!]
			ownership: EntryLiveCompetitionOwnershipFilterInput
			teamCountRules: [EntryLiveCompetitionTeamCountRuleInput!]
			expectedBoardRevision: String
		): EntryLiveCompetitionBoardPage!
		tournamentSelectionIndex(
			entryId: Int!
			tournamentId: Int!
			ref: LivePublicationRefInput!
		): TournamentSelectionIndex!
		tournamentEntrySquads(
			entryId: Int!
			tournamentId: Int!
			comparedEntryIds: [Int!]!
			ref: LivePublicationRefInput!
		): TournamentEntrySquads!
		tournamentLiveParticipants(entryId: Int!, tournamentId: Int!): [TournamentParticipant!]!
	}
`;
