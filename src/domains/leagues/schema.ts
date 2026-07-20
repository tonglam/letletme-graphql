export const leaguesTypeDefs = /* GraphQL */ `
	enum LeagueType {
		CLASSIC
		H2H
	}

	type League {
		id: Int!
		name: String!
		shortName: String
		type: LeagueType!
		created: String
		closed: Boolean
		maxEntries: Int
		scoring: String
		adminEntry: Int
		startEvent: Int
		startedEvent: Int
		entryRank: Int
		entryLastRank: Int
		tournamentId: Int
		tournamentName: String
		tournamentMode: String
		groupMode: String
		totalTeamNum: Int
		state: String
	}

	type LeagueEventResult {
		league: League!
		event: Event
		entryId: Int!
		entryName: String
		playerName: String
		eventPoints: Int!
		eventRank: Int
		overallPoints: Int!
		overallRank: Int!
	}

	extend type Query {
		entryLeagues(entryId: Int!): [League!]!
		leagueEventResults(leagueId: Int!, eventId: Int!): [LeagueEventResult!]!
	}
`;
