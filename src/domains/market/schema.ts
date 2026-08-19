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

	enum MarketOwnershipPeriod {
		DAILY
		GAMEWEEK
	}

	enum MarketOwnershipCoverageStatus {
		READY
		PARTIAL
		NO_DATA
		BASELINE_MISSING
		NO_PREVIOUS_GAMEWEEK
		NO_UPCOMING_GAMEWEEK
	}

	type MarketOwnershipCoverage {
		status: MarketOwnershipCoverageStatus!
		requestedDays: Int!
		observedDays: Int!
		firstDate: Date
		latestDate: Date
		fromDate: Date
		toDate: Date
		missingDates: [Date!]!
		capturedAt: DateTime
		complete: Boolean!
		stale: Boolean!
	}

	type MarketOwnershipChange {
		player: MarketPlayer!
		fromSelectedByPercent: Float!
		toSelectedByPercent: Float!
		changePercentagePoints: Float!
		fromDate: Date!
		toDate: Date!
	}

	type MarketOwnershipGameweek {
		id: Int!
		name: String!
		deadlineTime: DateTime!
	}

	type MarketOwnershipOverview {
		period: MarketOwnershipPeriod!
		gameweek: MarketOwnershipGameweek
		coverage: MarketOwnershipCoverage!
		risers: [MarketOwnershipChange!]!
		fallers: [MarketOwnershipChange!]!
	}

	type MarketOwnershipDay {
		period: MarketOwnershipPeriod!
		date: Date
		coverage: MarketOwnershipCoverage!
		risers: [MarketOwnershipChange!]!
		fallers: [MarketOwnershipChange!]!
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

	type MarketLineupSlot {
		player: MarketPlayer!
		row: Int!
		col: Int!
	}

	type MarketLineup {
		formation: String!
		totalOwnershipPercent: Float!
		slots: [MarketLineupSlot!]!
	}

	type MarketPulse {
		coverage: MarketCoverage!
		mostSelected: [MarketPlayer!]!
		transferMovers: [MarketTransferMover!]!
		availabilityUpdates: [MarketAvailabilityUpdate!]!
		availabilityHighlights: [MarketAvailabilityUpdate!]!
		newPlayers: [MarketNewPlayer!]!
		priceChanges: [MarketPriceChange!]!
		availabilityUpdateCount: Int!
	}

	enum MarketSnapshotSource {
		DATA_PUBLICATION
		POSTGRES_FALLBACK
	}

	type MarketSnapshotContext {
		season: String!
		revision: String!
		source: MarketSnapshotSource!
		snapshotDate: String
		capturedAt: DateTime
		rowCount: Int!
	}

	extend type Query {
		marketPulse(days: Int = 7): MarketPulse!
		marketLineup: MarketLineup!
		marketOwnershipOverview(
			period: MarketOwnershipPeriod!
			limit: Int = 10
		): MarketOwnershipOverview!
		marketOwnershipDay(date: Date, limit: Int = 10): MarketOwnershipDay!
		marketSnapshotContext: MarketSnapshotContext!
	}
`;
