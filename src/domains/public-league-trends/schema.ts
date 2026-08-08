export const publicLeagueTrendsTypeDefs = /* GraphQL */ `
	type PublicLeagueTrend {
		tournamentId: Int!
		displayName: String!
		sortOrder: Int!
		publishedAt: DateTime!
		updatedAt: DateTime!
		latestAvailableEventId: Int!
		totalEntries: Int!
	}

	extend type Query {
		publicLeagueTrends: [PublicLeagueTrend!]!
		publicLeagueSelectionStats(
			tournamentId: Int!
			eventId: Int!
			limit: Int = 12
		): TournamentSelectionStats
	}
`;
