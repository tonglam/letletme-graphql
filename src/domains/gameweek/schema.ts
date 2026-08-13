export const gameweekTypeDefs = /* GraphQL */ `
	enum GameweekLifecycleState {
		SCHEDULED
		PROVISIONAL
		SETTLED
	}

	enum GameweekSectionState {
		PENDING
		AVAILABLE
		UNAVAILABLE
	}

	type GameweekOverviewPlayer {
		id: Int!
		webName: String!
		teamShortName: String
	}

	type GameweekOverviewChips {
		benchBoost: Int
		tripleCaptain: Int
		wildcard: Int
		freeHit: Int
	}

	type GameweekOverview {
		averagePoints: Int
		highestPoints: Int
		mostCaptained: GameweekOverviewPlayer
		mostViceCaptained: GameweekOverviewPlayer
		mostSelected: GameweekOverviewPlayer
		mostTransferredIn: GameweekOverviewPlayer
		chipsPlayed: GameweekOverviewChips
	}

	type GameweekBoardPlayer {
		id: Int!
		webName: String!
		position: Position!
		teamShortName: String!
		price: Int!
		minutes: Int
		goalsScored: Int
		assists: Int
		cleanSheets: Int
		bonus: Int
		totalPoints: Int!
	}

	type GameweekDesk {
		season: String!
		coreRevision: String!
		liveRevision: String
		anchorEventId: Int!
		eventId: Int!
		currentEventId: Int
		nextEventId: Int
		isPreseason: Boolean!
		lifecycle: GameweekLifecycleState!
		deadlineTime: DateTime
		publishedAt: DateTime
		overviewState: GameweekSectionState!
		boardsState: GameweekSectionState!
		overview: GameweekOverview
		dreamTeam: [GameweekBoardPlayer!]!
		hauls: [GameweekBoardPlayer!]!
	}

	extend type Query {
		gameweekDesk(eventId: Int): GameweekDesk!
	}
`;
