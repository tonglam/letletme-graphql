export const homeTypeDefs = /* GraphQL */ `
	enum HomeRankDirection {
		UP
		DOWN
		FLAT
		UNKNOWN
	}

	enum HomeLeagueType {
		CLASSIC
		H2H
	}

	type HomeRankMovement {
		direction: HomeRankDirection!
		places: Int
	}

	type HomeLeagueRank {
		key: ID!
		name: String!
		leagueType: HomeLeagueType!
		rank: Int
		movement: HomeRankMovement!
		tournamentId: Int
	}

	enum HomePersonalDeskState {
		READY
		EMPTY
		STALE
		UNAVAILABLE
	}

	type HomePersonalDesk {
		state: HomePersonalDeskState!
		entryName: String
		playerName: String
		overallPoints: Int
		overallRank: Int
		teamValue: Int
		leagueRanks: [HomeLeagueRank!]!
		sourceCheckedAt: DateTime
	}

	type HomePublicBootstrap {
		context: CoreEventContext!
		fixtures: [Fixture!]!
	}

	type HomeMarketPulse {
		coverage: MarketCoverage!
		mostSelected: [MarketPlayer!]!
		availabilityUpdates: [MarketAvailabilityUpdate!]!
		priceChanges: [MarketPriceChange!]!
	}

	enum HomeTransferSectionState {
		AVAILABLE
		UNAVAILABLE
	}

	type HomeTransferSignal {
		player: Player!
		eventId: Int!
		transfersInEvent: Int!
		transfersOutEvent: Int!
	}

	type HomeGameweek {
		gameweekDesk: GameweekDesk!
		topTransfersIn: [HomeTransferSignal!]!
		topTransfersOut: [HomeTransferSignal!]!
		transfersState: HomeTransferSectionState!
	}

	extend type Query {
		homePublicBootstrap: HomePublicBootstrap!
		homeGameweek(eventId: Int!): HomeGameweek!
		homePersonalDesk: HomePersonalDesk!
		homeMarketPulse(days: Int = 7): HomeMarketPulse!
	}
`;
