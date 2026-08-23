export const liveDesksTypeDefs = /* GraphQL */ `
	input LiveRevisionRefInput {
		season: String!
		eventId: Int!
		revision: String!
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
		SCHEDULED
	}

	enum LiveSnapshotSource {
		REDIS
		POSTGRES
		CORE
		STALE
	}

	enum LiveWindowState {
		PRESEASON
		EVENT_SCHEDULED
		LIVE_ACTIVE
		DAY_SETTLING
		BETWEEN_FIXTURES
		GW_REVIEW
		FINALIZED
		BETWEEN_GAMEWEEKS
		OFFSEASON
	}

	enum LiveDataAvailability {
		SCHEDULED
		FRESH
		LAST_GOOD
		FINAL
		PARTIAL
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
		liveRevision: String
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
	}

	type LiveMatchSummary {
		fixtureId: Int!
		eventId: Int!
		homeTeamId: Int!
		homeTeamName: String!
		homeTeamShortName: String! @deprecated(reason: "Use core team identity")
		awayTeamId: Int!
		awayTeamName: String!
		awayTeamShortName: String! @deprecated(reason: "Use core team identity")
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
		revision: String!
		state: LiveSnapshotState!
		windowState: LiveWindowState!
		dataAvailability: LiveDataAvailability!
		liveRevision: String
		sourceCheckedAt: DateTime!
		publishedAt: DateTime!
		source: LiveSnapshotSource!
		stale: Boolean!
		nextRefreshAt: DateTime
		matches: [LiveMatchSummary!]!
		nextFixtures: [LiveMatchSummary!]!
			@deprecated(reason: "Use core eventFixtures for next-event schedule")
		highlights: [LivePerformance!]!
	}

	type LiveFixturePlayers {
		season: String!
		eventId: Int!
		revision: String!
		fixtureId: Int!
		players: [LivePerformance!]!
	}

	type EntryLiveCompetitionsDesk {
		season: String!
		eventId: Int!
		revision: String
		state: LiveSnapshotState!
		windowState: LiveWindowState!
		dataAvailability: LiveDataAvailability!
		nextRefreshAt: DateTime
		tournaments: [TournamentInfo!]!
		selectedTournamentId: Int
		board: [LiveCalcData!]!
		managerRevision: String
		officialCoverage: Float!
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
		OVERALL_RANK
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

	enum ManagerLiveServedFrom {
		REDIS
		POSTGRES
		MIXED
		NONE
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
		overallRank: Int!
		teamValue: Float!
		chip: String!
		livePoints: Int!
		transferCost: Int!
		liveNetPoints: Int!
		liveTotalPoints: Int!
		played: Int!
		toPlay: Int!
		captainId: Int!
		captainName: String!
		captainPoints: Int!
		score: LiveManagerScore!
	}

	type EntryLiveCompetitionBoardPage {
		season: String!
		eventId: Int!
		tournamentId: Int!
		boardRevision: String!
		playerRevision: String!
		managerRevision: String
		dataAvailability: LiveDataAvailability!
		managerDataAvailability: LiveDataAvailability!
		managerServedFrom: ManagerLiveServedFrom!
		managerRefreshQueued: Boolean!
		managerCheckedAt: DateTime
		managerNextRefreshAt: DateTime
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
		position: String!
		count: Int!
		percentage: Float!
	}

	type TournamentSelectionIndex {
		tournamentId: Int!
		eventId: Int!
		revision: String!
		rows: [TournamentSelectionIndexRow!]!
	}

	type TournamentEntrySquads {
		tournamentId: Int!
		eventId: Int!
		revision: String!
		state: LiveSnapshotState!
		entries: [LiveCalcData!]!
	}

	extend type Query {
		liveContext: LiveContext!
		liveMatchdayDesk(ref: LiveRevisionRefInput): LiveMatchdayDesk!
		liveFixturePlayers(ref: LiveRevisionRefInput!, fixtureId: Int!): LiveFixturePlayers!
		entryLiveCompetitionsDesk(
			entryId: Int!
			selectedTournamentId: Int
			ref: LiveRevisionRefInput
		): EntryLiveCompetitionsDesk!
		entryLiveCompetitionBoard(
			entryId: Int!
			tournamentId: Int!
			eventId: Int!
			ref: LiveRevisionRefInput
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
			ref: LiveRevisionRefInput!
		): TournamentSelectionIndex!
		tournamentEntrySquads(
			entryId: Int!
			tournamentId: Int!
			comparedEntryIds: [Int!]!
			ref: LiveRevisionRefInput!
		): TournamentEntrySquads!
		tournamentLiveParticipants(entryId: Int!, tournamentId: Int!): [TournamentParticipant!]!
	}
`;
