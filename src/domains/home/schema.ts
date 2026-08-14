export const homeTypeDefs = /* GraphQL */ `
	enum HomeRankDirection {
		UP
		DOWN
		FLAT
		UNKNOWN
	}

	type HomeRankMovement {
		direction: HomeRankDirection!
		places: Int
	}

	type HomeLeagueRank {
		key: ID!
		name: String!
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
		ownershipMovers: MarketOwnershipMovers!
		availabilityUpdates: [MarketAvailabilityUpdate!]!
		priceChanges: [MarketPriceChange!]!
	}

	extend type Query {
		homePublicBootstrap: HomePublicBootstrap!
		homePersonalDesk: HomePersonalDesk!
		homeMarketPulse(days: Int = 14): HomeMarketPulse!
	}
`;
