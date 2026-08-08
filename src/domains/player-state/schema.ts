export const playerStateTypeDefs = /* GraphQL */ `
	enum PlayerStateTrend {
		RISING
		STABLE
		FALLING
		MIXED
		UNAVAILABLE
		UNKNOWN
	}

	enum PlayerStateConfidence {
		HIGH
		MEDIUM
		LOW
	}

	enum PlayerStateDirection {
		RISING
		STABLE
		FALLING
		UNKNOWN
	}

	enum PlayerStateDimensionKind {
		AVAILABILITY_ROLE
		FPL_OUTPUT
		REAL_WORLD_PROCESS
		HISTORICAL_RELIABILITY
		OUTLOOK
	}

	enum PlayerStateDimensionRating {
		SECURE
		MANAGED
		AT_RISK
		STRONG
		TYPICAL
		WEAK
		PROVEN
		VARIABLE
		EMERGING
		INSUFFICIENT
		FAVOURABLE
		NEUTRAL
		DIFFICULT
		TEAM_CONTEXT_ONLY
		UNAVAILABLE
		UNKNOWN
	}

	enum PlayerStateMetricSource {
		FPL_CURRENT
		FPL_HISTORY
		UNDERSTAT_CURRENT
		UNDERSTAT_HISTORY
		DERIVED
	}

	enum PlayerStateMappingStatus {
		VERIFIED
		UNVERIFIED
		AMBIGUOUS
		QUARANTINED
		UNAVAILABLE
	}

	enum PlayerStateProvider {
		FPL
		UNDERSTAT
	}

	enum PlayerStateProviderScope {
		CURRENT
		HISTORY
	}

	type PlayerStateMetric {
		code: String!
		source: PlayerStateMetricSource!
		value: Float
		baseline: Float
		percentile: Float
		unit: String!
		season: String
		sampleMinutes: Int
		sampleSize: Int
		smallSample: Boolean!
		capability: Boolean!
	}

	type PlayerStateReason {
		code: String!
		dimension: PlayerStateDimensionKind!
		current: Float
		baseline: Float
		percentile: Float
	}

	type PlayerStateDimension {
		kind: PlayerStateDimensionKind!
		rating: PlayerStateDimensionRating!
		direction: PlayerStateDirection!
		confidence: PlayerStateConfidence!
		reasonCodes: [String!]!
		metrics: [PlayerStateMetric!]!
	}

	type PlayerStateFixture {
		id: Int!
		opponentTeamShortName: String!
		wasHome: Boolean!
		difficulty: Int!
		kickoffTime: DateTime
	}

	type PlayerStateOutlookGameweek {
		eventId: Int!
		bgw: Boolean!
		dgw: Boolean!
		averageDifficulty: Float
		fixtures: [PlayerStateFixture!]!
	}

	type PlayerStateOutlook {
		rating: PlayerStateDimensionRating!
		horizon: Int!
		averageDifficulty: Float
		gameweeks: [PlayerStateOutlookGameweek!]!
	}

	type PlayerStateBaselineSeason {
		season: String!
		position: Int!
		minutes: Int!
		pointsPer90: Float
		returnRate: Float
		bonusPer90: Float
		positionPercentile: Float
		weight: Float!
		expectedMetricsAvailable: Boolean!
		understatProcessPercentile: Float
	}

	type PlayerStateOwnBaseline {
		weightedPercentile: Float
		seasons: [PlayerStateBaselineSeason!]!
	}

	type PlayerStatePeerBaseline {
		position: Int!
		minimumMinutes: Int!
		cohortSize: Int!
		currentPercentile: Float
	}

	type PlayerStateCareerPoint {
		season: String!
		position: Int!
		minutes: Int!
		fplPositionPercentile: Float
		understatProcessPercentile: Float
		expectedMetricsAvailable: Boolean!
	}

	type PlayerStateProviderRevision {
		provider: PlayerStateProvider!
		scope: PlayerStateProviderScope!
		season: String!
		revision: String
		asOf: DateTime
		freshnessSeconds: Int
		stale: Boolean!
		available: Boolean!
	}

	type PlayerStateCoverage {
		fplCurrent: Boolean!
		understatCurrent: Boolean!
		fplHistorySeasons: [String!]!
		understatHistorySeasons: [String!]!
		mappingStatus: PlayerStateMappingStatus!
		metricCoverage: [String!]!
		limitations: [String!]!
		providers: [PlayerStateProviderRevision!]!
	}

	type PlayerStateProfile {
		playerId: Int!
		playerCode: Int!
		teamId: Int!
		position: Int!
		season: String!
		horizon: Int!
		asOfEventId: Int
		asOf: DateTime!
		trend: PlayerStateTrend!
		confidence: PlayerStateConfidence!
		fplOnly: Boolean!
		reasons: [PlayerStateReason!]!
		dimensions: [PlayerStateDimension!]!
		ownBaseline: PlayerStateOwnBaseline!
		peerBaseline: PlayerStatePeerBaseline!
		careerTrajectory: [PlayerStateCareerPoint!]!
		outlook: PlayerStateOutlook!
		coverage: PlayerStateCoverage!
	}

	extend type Query {
		playerStateProfile(playerId: Int!, horizon: Int = 5): PlayerStateProfile
	}
`;
