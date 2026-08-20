export const playerStatsTypeDefs = /* GraphQL */ `
	type PlayerStatsBootstrap {
		context: CoreEventContext!
		teams: [Team!]!
		directory: PlayersForPickerPayload!
	}

	type PlayerStatsOverview {
		id: Int!
		webName: String!
		teamShortName: String!
		elementType: Int!
		elementTypeName: String!
		price: Float!
		startPrice: Float!
		statsContext: PlayerStatsContext!
		availability: PlayerAvailability
		totalPoints: Int
		selectedByPercent: Float
		form: Float
		seasonTransfersIn: Int
		seasonTransfersOut: Int
		transfersInEvent: Int
		transfersOutEvent: Int
		eventPoints: Int
		minutes: Int
		starts: Int
		goalsScored: Int
		assists: Int
		cleanSheets: Int
		bonus: Int
		bps: Int
		expectedGoals: Float
		expectedAssists: Float
		expectedGoalInvolvements: Float
		fixtures: [PlayerFixture!]!
	}

	enum PlayerStatsDeskFieldStatus {
		AVAILABLE
		NOT_FOUND
		TEMPORARILY_UNAVAILABLE
	}

	type PlayerStatsOverviewResult {
		status: PlayerStatsDeskFieldStatus!
		value: PlayerStatsOverview
	}

	type PlayerStatsStateResult {
		status: PlayerStatsDeskFieldStatus!
		value: PlayerStateProfile
	}

	type PlayerStatsEvidenceResult {
		status: PlayerStatsDeskFieldStatus!
		value: PlayerDetail
	}

	type PlayerStatsDeskEntry {
		playerId: Int!
		overview: PlayerStatsOverviewResult!
		state: PlayerStatsStateResult!
		evidence: PlayerStatsEvidenceResult!
	}

	type PlayerStatsDeskPayload {
		eventId: Int!
		horizon: Int!
		entries: [PlayerStatsDeskEntry!]!
	}

	extend type Query {
		playerStatsBootstrap(limit: Int = 20): PlayerStatsBootstrap!
		playerStatsDesk(playerIds: [Int!]!, eventId: Int!, horizon: Int = 5): PlayerStatsDeskPayload!
	}
`;
