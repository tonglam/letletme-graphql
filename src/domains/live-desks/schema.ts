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
		awayTeamId: Int!
		awayTeamName: String!
		homeScore: Int
		awayScore: Int
		kickoffTime: DateTime
		minutes: Int!
		started: Boolean!
		finished: Boolean!
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

	type TournamentSelectionIndexRow {
		playerId: Int!
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
