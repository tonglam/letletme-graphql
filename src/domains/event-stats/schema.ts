export const eventStatsTypeDefs = /* GraphQL */ `
	type SelectionStatPlayer {
		id: Int!
		webName: String!
		teamShortName: String!
		position: Position!
		selectedByPercent: Float!
		eoByPercent: Float
	}

	type CaptainStatPlayer {
		id: Int!
		webName: String!
		teamShortName: String!
		position: Position!
		captainByPercent: Float!
		selectedByPercent: Float!
		eoByPercent: Float
	}

	type TransferStatPlayer {
		id: Int!
		webName: String!
		teamShortName: String!
		position: Position!
		transfersEvent: Int!
		selectedByPercent: Float!
	}

	type TournamentSelectionStats {
		totalEntries: Int!
		goalkeepers: [SelectionStatPlayer!]!
		defenders: [SelectionStatPlayer!]!
		midfielders: [SelectionStatPlayer!]!
		forwards: [SelectionStatPlayer!]!
		captainSelect: [CaptainStatPlayer!]!
		viceCaptainSelect: [CaptainStatPlayer!]!
		mostSelectedPlayers: [SelectionStatPlayer!]!
		mostTransferIn: [TransferStatPlayer!]!
		mostTransferOut: [TransferStatPlayer!]!
	}

	extend type Query {
		tournamentSelectionStats(
			tournamentId: Int!
			eventId: Int!
			limit: Int = 10
		): TournamentSelectionStats
	}
`;
