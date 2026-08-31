export const liveMatchesTypeDefs = /* GraphQL */ `
	enum MatchLifecycleState {
		PRE_DEADLINE
		LIVE_ACTIVE
		BETWEEN_FIXTURES
		DAY_SETTLING
		GW_REVIEW
		FINALIZED
	}

	enum ElementPosition {
		GOALKEEPER
		DEFENDER
		MIDFIELDER
		FORWARD
	}

	enum LiveMatchAvailability {
		READY
		UNAVAILABLE
	}

	enum LiveMatchDeliveryState {
		FRESH
		STALE
		DEGRADED
		FINAL
		PENDING
		UNAVAILABLE
	}

	enum LiveMatchServedFrom {
		REDIS_CURRENT
		REDIS_PREVIOUS
		PROCESS_LKG
		POSTGRES_CHECKPOINT
	}

	type LiveMatchDelivery {
		state: LiveMatchDeliveryState!
		servedFrom: LiveMatchServedFrom
		reasonCodes: [String!]!
	}

	type LiveMatchRevisionVector {
		deskPublicationId: ID!
		deskGeneration: Int!
		lifecycle: String!
		fixtureIdentity: String!
		scoreState: String!
		corePriceRevision: String
		detailPublicationId: ID
		detailGeneration: Int
		playerDetail: String
	}

	type LiveMatchTimes {
		deskSourceCheckedAt: DateTime!
		deskContentUpdatedAt: DateTime!
		deskPublishedAt: DateTime!
		deskStaleAt: DateTime
		detailSourceCheckedAt: DateTime
		detailContentUpdatedAt: DateTime
		detailPublishedAt: DateTime
		detailStaleAt: DateTime
		servedAt: DateTime!
		nextRefreshAt: DateTime
	}

	type LiveMatchPlayerStat {
		identifier: String!
		value: Float!
		points: Float!
		pointsModification: Float
	}

	type LiveMatchPlayer {
		id: Int!
		webName: String!
		position: ElementPosition!
		teamId: Int!
		# Current canonical FPL price in tenths of £m. A missing Core
		# publication must not make the live match publication unusable.
		price: Int
		totalPoints: Int!
		stats: [LiveMatchPlayerStat!]!
	}

	type LiveMatchFixture {
		fixtureId: Int!
		eventId: Int!
		homeTeamId: Int!
		homeTeamName: String!
		homeTeamShortName: String!
		awayTeamId: Int!
		awayTeamName: String!
		awayTeamShortName: String!
		homeScore: Int
		awayScore: Int
		kickoffTime: DateTime
		minutes: Int!
		started: Boolean!
		finished: Boolean!
		finishedProvisional: Boolean!
		players: [LiveMatchPlayer!]!
	}

	type LiveMatchdaySnapshot {
		season: String!
		eventId: Int!
		state: MatchLifecycleState!
		revisions: LiveMatchRevisionVector!
		times: LiveMatchTimes!
		detailDelivery: LiveMatchDelivery!
		matches: [LiveMatchFixture!]!
	}

	type LiveMatchdayResult {
		availability: LiveMatchAvailability!
		delivery: LiveMatchDelivery!
		snapshot: LiveMatchdaySnapshot
	}

	extend type Query {
		liveMatchday(eventId: Int): LiveMatchdayResult!
	}
`;
