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

	enum PriceChangeLiveState {
		PROVISIONAL
		DURABLE
		UNAVAILABLE
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

	type PriceChangeLiveCursor {
		seasonCode: String!
		revision: String
		sourceHash: String
		state: PriceChangeLiveState!
		detectedAt: DateTime
		fetchedAt: DateTime
		expiresAt: DateTime
	}

	type PriceChangeLiveBoard {
		revision: String!
		sourceHash: String
		state: PriceChangeLiveState!
		detectedAt: DateTime
		expiresAt: DateTime
		durablePublicationId: ID
		board: PriceChangeBoard!
	}

	extend type Query {
		priceChangeBoard: PriceChangeBoard!
		priceChangeLiveCursor(seasonCode: String): PriceChangeLiveCursor!
		priceChangeLiveBoard(
			seasonCode: String
			revision: String
			sourceHash: String
		): PriceChangeLiveBoard!
	}
`;
