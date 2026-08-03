export const marketTypeDefs = /* GraphQL */ `
	type MarketPlayer {
		playerId: Int!
		playerCode: Int!
		webName: String!
		teamId: Int!
		teamName: String!
		teamShortName: String!
		position: Position!
		price: Int!
		selectedByPercent: Float!
	}

	type MarketCoverage {
		requestedDays: Int!
		observedDays: Int!
		firstDate: Date
		latestDate: Date
		capturedAt: DateTime
		complete: Boolean!
		stale: Boolean!
	}

	type MarketOwnershipMover {
		player: MarketPlayer!
		previousSelectedByPercent: Float!
		selectedByPercent: Float!
		change: Float!
	}

	type MarketOwnershipMovers {
		risers: [MarketOwnershipMover!]!
		fallers: [MarketOwnershipMover!]!
	}

	type MarketTransferMover {
		player: MarketPlayer!
		transfersIn: Int!
		transfersOut: Int!
		netTransfers: Int!
	}

	type MarketAvailabilityUpdate {
		player: MarketPlayer!
		status: String!
		previousStatus: String
		news: String!
		newsAdded: DateTime
		observedDate: Date!
		chanceOfPlayingThisRound: Int
		chanceOfPlayingNextRound: Int
	}

	type MarketNewPlayer {
		player: MarketPlayer!
		firstObservedDate: Date!
	}

	type MarketPriceChange {
		player: MarketPlayer!
		changeDate: Date!
		oldPrice: Int!
		newPrice: Int!
		change: Int!
		direction: PriceChangeType!
	}

	type MarketPulse {
		coverage: MarketCoverage!
		mostSelected: [MarketPlayer!]!
		ownershipMovers: MarketOwnershipMovers!
		transferMovers: [MarketTransferMover!]!
		availabilityUpdates: [MarketAvailabilityUpdate!]!
		newPlayers: [MarketNewPlayer!]!
		priceChanges: [MarketPriceChange!]!
	}

	extend type Query {
		marketPulse(days: Int = 14): MarketPulse!
	}
`;
