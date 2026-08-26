export const priceChangesTypeDefs = /* GraphQL */ `
	enum PriceChangeBoardStatus {
		READY
		PARTIAL
		STALE
		UNAVAILABLE
	}

	enum PriceChangePredictionStatus {
		VERY_LIKELY_RISE
		LIKELY_RISE
		UNLIKELY
		LIKELY_FALL
		VERY_LIKELY_FALL
		LOCKED
		CALIBRATING
	}

	enum PriceChangeOwnershipTrend {
		UP
		DOWN
		FLAT
	}

	enum PriceChangeSource {
		FPL_BOOTSTRAP
	}

	type PriceChangeProjection {
		offset: Int!
		projectedPercent: Float!
		likelihood: Float!
	}

	type PriceChangePlayer {
		playerId: Int!
		playerCode: Int!
		webName: String!
		teamId: Int!
		teamName: String!
		teamShortName: String!
		position: String!
		currentPrice: Int!
		selectedByPercent: Float!
		progressPercent: Float!
		hourlyRate: Float!
		status: PriceChangePredictionStatus!
		ownershipTrend: PriceChangeOwnershipTrend!
		transfersInEvent: Int!
		transfersOutEvent: Int!
		lockedUntil: DateTime
		calibrating: Boolean!
		projections: [PriceChangeProjection!]!
	}

	type PriceChangeBoard {
		status: PriceChangeBoardStatus!
		source: PriceChangeSource!
		deadline: DateTime
		nextDeadlines: [DateTime!]!
		fetchedAt: DateTime
		staleAt: DateTime
		revision: String!
		completeness: DataCompletenessMeta
		expectedPlayerCount: Int!
		observedPlayerCount: Int!
		players: [PriceChangePlayer!]!
	}

	extend type Query {
		priceChangeBoard: PriceChangeBoard!
	}
`;
