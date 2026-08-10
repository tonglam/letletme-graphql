export const liveMatchesTypeDefs = /* GraphQL */ `
	"""
	Play status for filtering live matches.
	"""
	enum MatchPlayStatus {
		"""
		Matches that have not started
		"""
		NOT_STARTED
		"""
		Matches currently in progress
		"""
		PLAYING
		"""
		Matches that have finished
		"""
		FINISHED
	}

	"""
	Live match data with team information and player performances.
	"""
	type LiveMatchData {
		matchId: Int!
		minutes: Int!
		homeTeamId: Int!
		homeTeamName: String!
		homeTeamShortName: String!
		homePosition: Int!
		homeScore: Int!
		homeTeamDataList: [ElementEventResultData!]!
		awayTeamId: Int!
		awayTeamName: String!
		awayTeamShortName: String!
		awayPosition: Int!
		awayScore: Int!
		awayTeamDataList: [ElementEventResultData!]!
		kickoffTime: DateTime
		playStatus: MatchPlayStatus!
	}

	"""
	Live matches grouped by play status.
	"""
	type LiveMatches {
		"""
		Matches scheduled but not started
		"""
		notStarted: [LiveMatchData!]!
		"""
		Matches currently in progress
		"""
		playing: [LiveMatchData!]!
		"""
		Matches that have finished
		"""
		finished: [LiveMatchData!]!
	}

	extend type Query {
		"""
		Query live matches grouped by play status.
		"""
		liveMatches: LiveMatches!
	}
`;
