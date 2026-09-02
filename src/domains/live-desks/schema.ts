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

	enum LeagueLiveAvailability {
		READY
		PENDING
		MISSING
		ERROR
	}

	enum LeagueLiveMode {
		CLASSIC
		H2H
	}

	type LeagueLiveRevisionVector {
		publicationId: ID!
		generation: Int!
		roster: String!
		scoreCore: String!
		fixtureIdentity: String!
		entryInputSet: String!
		identity: String!
		officialRank: String
		rules: String!
		algorithm: String!
		content: String!
	}

	type LeagueLivePublicationMeta {
		revisions: LeagueLiveRevisionVector!
		times: LiveTimes!
	}

	type LeagueLiveHead {
		season: String!
		eventId: Int!
		tournamentId: Int!
		mode: LeagueLiveMode!
		availability: LeagueLiveAvailability!
		contentRevision: String
		publication: LeagueLivePublicationMeta
		delivery: LiveDelivery!
		nextRefreshAt: DateTime
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

	input EntryLiveCompetitionBoardInput {
		first: Int = 20
		after: String
		sort: EntryLiveCompetitionBoardSort = EVENT_POINTS
		direction: EntryLiveCompetitionBoardSortDirection = DESC
		search: String
		chips: [String!]
		captainPlayerIds: [Int!]
		ownership: EntryLiveCompetitionOwnershipFilterInput
		teamCountRules: [EntryLiveCompetitionTeamCountRuleInput!]
	}

	type EntryLiveCompetitionBoardRow {
		availability: LeagueLiveAvailability!
		entry: Int!
		entryName: String!
		playerName: String!
		liveRank: Int
		overallRank: Int
		teamValue: Float
		chip: String
		transferCost: Int
		played: Int
		toPlay: Int
		captainId: Int
		captainName: String
		captainPoints: Int
		score: LiveScore
	}

	type CursorPageInfo {
		hasNextPage: Boolean!
		endCursor: String
	}

	type EntryLiveCompetitionBoardPage {
		head: LeagueLiveHead!
		totalEntries: Int!
		filteredEntries: Int!
		pageInfo: CursorPageInfo!
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
		leagueLiveHead(
			entryId: Int!
			tournamentId: Int!
			eventId: Int!
			mode: LeagueLiveMode!
		): LeagueLiveHead!
		entryLiveCompetitionBoard(
			entryId: Int!
			tournamentId: Int!
			eventId: Int!
			input: EntryLiveCompetitionBoardInput
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
