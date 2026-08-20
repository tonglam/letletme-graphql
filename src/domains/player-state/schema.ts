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
		NOT_APPLICABLE
	}

	enum PlayerStateDataStatus {
		AVAILABLE
		UNAVAILABLE
	}

	enum PlayerStateAnalysisStatus {
		READY
		PRESEASON
		INSUFFICIENT
		NOT_APPLICABLE
		UNAVAILABLE
	}

	enum PlayerStateProviderMode {
		FPL_ONLY
		FPL_WITH_UNDERSTAT_HISTORY
		FPL_WITH_UNDERSTAT_CURRENT
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

	enum PlayerRadarDirection {
		HIGHER_IS_BETTER
		LOWER_IS_BETTER
		NEUTRAL
	}

	type PlayerRadarAxis {
		code: String!
		value: Float
		percentile: Float
		unit: String!
		direction: PlayerRadarDirection!
		sampleMinutes: Int
		available: Boolean!
		capability: Boolean!
		reasonCode: String
	}

	type PlayerRadarProfile {
		source: PlayerStateProvider!
		position: Int!
		season: String!
		asOfEventId: Int
		sampleMinutes: Int!
		smallSample: Boolean!
		axes: [PlayerRadarAxis!]!
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

	type PlayerStateSourceCoverage {
		provider: PlayerStateProvider!
		scope: PlayerStateProviderScope!
		seasons: [String!]!
		dataStatus: PlayerStateDataStatus!
		analysisStatus: PlayerStateAnalysisStatus!
		mappingStatus: PlayerStateMappingStatus!
		reasonCodes: [String!]!
		revision: String
		asOf: DateTime
		freshnessSeconds: Int
		stale: Boolean!
	}

	type PlayerStateCoverage {
		sources: [PlayerStateSourceCoverage!]!
		metricCoverage: [String!]!
		limitations: [String!]!
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
		providerMode: PlayerStateProviderMode!
		reasons: [PlayerStateReason!]!
		profileRadar: PlayerRadarProfile
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
