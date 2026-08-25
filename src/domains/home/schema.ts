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

	enum HomeLeagueVisibility {
		PRIVATE
		PUBLIC
	}

	enum HomeRankState {
		READY
		UPDATING
		UNAVAILABLE
	}

	enum HomePointsState {
		LIVE
		STALE
		SETTLING
		FINAL
		UNAVAILABLE
	}

	type HomeRankMovement {
		direction: HomeRankDirection!
		places: Int
	}

	type HomeH2HMatchupSide {
		entryId: Int
		entryName: String
		playerName: String
		isAverage: Boolean!
		points: Int
	}

	type HomeH2HMatchup {
		officialMatchId: Int!
		eventId: Int!
		isLive: Boolean!
		isFinal: Boolean!
		isBye: Boolean!
		viewer: HomeH2HMatchupSide!
		opponent: HomeH2HMatchupSide!
		sourceCheckedAt: DateTime
	}

	type HomeLeagueRank {
		key: ID!
		name: String!
		leagueType: HomeLeagueType!
		visibility: HomeLeagueVisibility!
		rank: Int
		rankState: HomeRankState!
		rankCheckedAt: DateTime
		movement: HomeRankMovement!
		tournamentId: Int
		h2hMatchup: HomeH2HMatchup
	}

	enum HomePersonalDeskState {
		READY
		EMPTY
		STALE
		UNAVAILABLE
	}

	type HomePersonalDesk {
		entryId: Int!
		state: HomePersonalDeskState!
		entryName: String
		playerName: String
		region: String
		overallPoints: Int
		pointsState: HomePointsState!
		pointsCheckedAt: DateTime
		overallRank: Int
		rankState: HomeRankState!
		rankCheckedAt: DateTime
		teamValue: Int
		bank: Int
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
