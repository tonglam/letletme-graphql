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
		STALE
	}

	type LiveContext {
		season: String!
		coreRevision: String!
		currentEventId: Int
		nextEventId: Int
		liveRevision: String
		state: LiveLifecycleState!
		sourceCheckedAt: DateTime
		publishedAt: DateTime
		source: LiveSnapshotSource
		stale: Boolean!
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
		started: Boolean!
		finished: Boolean!
	}

	type LiveMatchdayDesk {
		season: String!
		eventId: Int!
		revision: String!
		state: LiveSnapshotState!
		publishedAt: DateTime!
		matches: [LiveMatchSummary!]!
		nextFixtures: [LiveMatchSummary!]!
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
		tournaments: [TournamentInfo!]!
		selectedTournamentId: Int
		board: [LiveCalcData!]!
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
