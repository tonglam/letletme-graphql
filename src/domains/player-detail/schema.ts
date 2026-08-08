export const playerDetailTypeDefs = /* GraphQL */ `
	enum PlayerStatsScope {
		CURRENT_SEASON
		PREVIOUS_SEASON
		UNAVAILABLE
	}

	type PlayerStatsContext {
		scope: PlayerStatsScope!
		season: String!
		asOfEventId: Int
	}

	type PlayerAvailability {
		status: String!
		news: String!
		newsAdded: DateTime
		observedDate: Date!
		capturedAt: DateTime!
		chanceOfPlayingThisRound: Int
		chanceOfPlayingNextRound: Int
		stale: Boolean!
	}

	type PlayerRecentOpponent {
		teamShortName: String!
		wasHome: Boolean!
	}

	type PlayerRecentGameweek {
		eventId: Int!
		provisional: Boolean!
		totalPoints: Int!
		minutes: Int
		started: Boolean
		goalsScored: Int
		assists: Int
		cleanSheets: Int
		saves: Int
		bonus: Int
		bps: Int
		opponents: [PlayerRecentOpponent!]!
	}

	type PlayerDetail {
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
		goalsConceded: Int
		ownGoals: Int
		penaltiesSaved: Int
		yellowCards: Int
		redCards: Int
		saves: Int
		bonus: Int
		bps: Int

		expectedGoals: Float
		expectedAssists: Float
		expectedGoalInvolvements: Float
		expectedGoalsConceded: Float
		influence: Float
		creativity: Float
		threat: Float
		ictIndex: Float

		recentGameweeks: [PlayerRecentGameweek!]!
		fixtures: [PlayerFixture!]!
	}

	type PlayerFixture {
		id: Int!
		event: Int!
		againstTeamShortName: String!
		wasHome: Boolean!
		finished: Boolean!
		kickoffTime: String
		score: String
		difficulty: Int!
		bgw: Boolean!
	}

	extend type Query {
		playerDetail(playerId: Int!, eventId: Int!): PlayerDetail
	}
`;
