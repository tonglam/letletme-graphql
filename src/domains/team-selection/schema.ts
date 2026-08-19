export const teamSelectionTypeDefs = /* GraphQL */ `
	enum TeamSelectionPhase {
		PRESEASON
		PRE_DEADLINE
		LIVE
		SETTLING
		SETTLED
		BETWEEN_GAMEWEEKS
		OFFSEASON
		UNAVAILABLE
	}

	type TeamSelectionRulePosition {
		id: Int!
		name: String!
		shortName: String!
		squadSelect: Int!
		minPlay: Int!
		maxPlay: Int!
	}

	type TeamSelectionRuleChipWindow {
		id: Int!
		name: String!
		number: Int!
		startEvent: Int!
		stopEvent: Int!
		chipType: String!
	}

	type TeamSelectionRules {
		squadSize: Int!
		startingSize: Int!
		budget: Int!
		maxPlayersPerTeam: Int!
		currencyMultiplier: Int!
		positions: [TeamSelectionRulePosition!]!
		chips: [TeamSelectionRuleChipWindow!]!
	}

	type TeamSelectionPlayer {
		id: Int!
		code: Int!
		webName: String!
		firstName: String
		secondName: String
		team: Team!
		position: Position!
		price: Int!
		ownership: Float
		form: Float
		totalPoints: Int!
		status: String
		news: String
		chanceOfPlaying: Int
	}

	type TeamSelectionFixtureTeam {
		id: Int!
		name: String!
		shortName: String!
	}

	type TeamSelectionFixture {
		id: Int!
		eventId: Int!
		kickoffTime: DateTime
		homeTeam: TeamSelectionFixtureTeam!
		awayTeam: TeamSelectionFixtureTeam!
		homeDifficulty: Int
		awayDifficulty: Int
	}

	type TeamSelectionSection {
		state: GameweekSectionState!
		checkedAt: DateTime
		message: String
	}

	type TeamSelectionDesk {
		season: String!
		coreRevision: String!
		marketRevision: String
		checkedAt: DateTime!
		deadline: DateTime
		phase: TeamSelectionPhase!
		eventId: Int!
		horizon: Int!
		rules: TeamSelectionRules
		players: [TeamSelectionPlayer!]!
		fixtures: [TeamSelectionFixture!]!
		playerPool: TeamSelectionSection!
		fixtureSection: TeamSelectionSection!
		rulesSection: TeamSelectionSection!
	}

	extend type Query {
		teamSelectionDesk(eventId: Int!, horizon: Int = 5): TeamSelectionDesk!
	}
`;
