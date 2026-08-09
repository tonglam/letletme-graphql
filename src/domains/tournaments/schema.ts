export const tournamentsTypeDefs = /* GraphQL */ `
	enum TournamentMode {
		NORMAL
	}

	enum GroupMode {
		NO_GROUP
		POINTS_RACES
		BATTLE_RACES
	}

	enum KnockoutMode {
		NO_KNOCKOUT
		SINGLE_ELIMINATION
		DOUBLE_ELIMINATION
		HEAD_TO_HEAD
	}

	enum TournamentState {
		ACTIVE
		INACTIVE
		FINISHED
	}

	enum TournamentSetupStatus {
		PENDING
		PROCESSING
		READY
		FAILED
	}

	enum TournamentSetupPhase {
		QUEUED
		SYNCING_ENTRIES
		BUILDING_STRUCTURE
		CALCULATING_STANDINGS
		ENRICHING_HISTORY
		FINALIZING
		READY
		FAILED
	}

	enum TournamentRosterMode {
		SNAPSHOT
		OFFICIAL_SYNC
	}

	type TournamentInfo {
		id: Int!
		name: String!
		creator: String!
		adminEntryId: Int!
		leagueId: Int!
		leagueType: LeagueType!
		sourceLeagueName: String
		rosterMode: TournamentRosterMode!
		rosterSyncStatus: TournamentSetupStatus
		rosterLastSyncedAt: DateTime
		totalTeamNum: Int!
		tournamentMode: TournamentMode!
		groupMode: GroupMode
		groupTeamNum: Int
		groupNum: Int
		groupStartedEventId: Int
		groupEndedEventId: Int
		groupAutoAverages: Boolean!
		groupRounds: Int
		groupPlayAgainstNum: Int
		groupQualifyNum: Int
		knockoutMode: KnockoutMode
		knockoutTeamNum: Int
		knockoutRounds: Int
		knockoutEventNum: Int
		knockoutStartedEventId: Int
		knockoutEndedEventId: Int
		knockoutPlayAgainstNum: Int
		state: TournamentState!
		setupStatus: TournamentSetupStatus!
		setupPhase: TournamentSetupPhase!
		setupCompletedUnits: Int!
		setupTotalUnits: Int!
		setupProgressUpdatedAt: DateTime
		standingsReadyAt: DateTime
		setupHasWarnings: Boolean!
		setupStartedAt: DateTime
		setupFinishedAt: DateTime
		createdAt: DateTime!
		updatedAt: DateTime!
	}

	type TournamentParticipant {
		entryId: Int!
		entryName: String
		playerName: String
	}

	type TournamentEventResult {
		tournament: TournamentInfo!
		event: Event
		captain: Player
		groupId: Int!
		entryId: Int!
		entryName: String
		playerName: String
		eventGroupRank: Int
		eventPoints: Int
		eventCost: Int
		eventNetPoints: Int
		eventRank: Int
		overallPoints: Int
		overallRank: Int
		eventChip: Chip
		captainId: Int
		captainPoints: Int
		teamValue: Int
		bank: Int
	}

	type TournamentEntryRankingSummary {
		entryId: Int!
		overallRank: Int
		tournamentOverallRank: Int
		"""
		Cumulative official FPL points for this entry at the selected event.
		"""
		overallPoints: Int
		"""
		Cumulative official FPL points of the tournament leader at the selected event.
		"""
		leaderOverallPoints: Int
		"""
		Points separating this entry from the leader (zero when leading).
		"""
		gapToLeader: Int
		"""
		Points separating this entry from the next higher-ranked entry.
		"""
		pointsBehindNext: Int
		"""
		Points separating this entry from the next lower-ranked entry.
		"""
		pointsAheadOfPrev: Int
		teamValue: Int
		tournamentTeamValueRank: Int
		transfersNum: Int
		tournamentTransfersRank: Int
		totalCosts: Int
		tournamentCostsRank: Int
		totalBenchPoints: Int
		tournamentBenchPointsRank: Int
		autoSubPoints: Int
		tournamentAutoSubRank: Int
	}

	type TournamentBattleGroupResult {
		tournament: TournamentInfo!
		event: Event
		matchId: Int!
		groupId: Int!
		homeEntryId: Int!
		homeEntryName: String
		homePlayerName: String
		homeNetPoints: Int
		"""
		Rank within the H2H battle group (tiebroken by FPL overall rank). Not global FPL rank.
		"""
		homeRank: Int
		"""
		H2H match points: 3 = win, 1 = draw, 0 = loss. Sums to 3 with awayMatchPoints when both non-null.
		"""
		homeMatchPoints: Int
		awayEntryId: Int!
		awayEntryName: String
		awayPlayerName: String
		awayNetPoints: Int
		"""
		Rank within the H2H battle group (tiebroken by FPL overall rank). Not global FPL rank.
		"""
		awayRank: Int
		awayMatchPoints: Int
	}

	type EntryH2HMatchResult {
		tournament: TournamentInfo!
		event: Event
		matchId: Int!
		groupId: Int!
		entryId: Int!
		entryName: String
		playerName: String
		entryNetPoints: Int
		"""
		Rank within the H2H battle group. Not global FPL rank.
		"""
		entryRank: Int
		"""
		H2H match points for the queried entry: 3 = win, 1 = draw, 0 = loss.
		"""
		entryMatchPoints: Int
		entryEventPoints: Int
		entryTransferCost: Int
		entryOverallRank: Int
		entryChip: Chip
		opponentEntryId: Int!
		opponentEntryName: String
		opponentPlayerName: String
		opponentNetPoints: Int
		"""
		Rank within the H2H battle group. Not global FPL rank.
		"""
		opponentRank: Int
		opponentMatchPoints: Int
		opponentEventPoints: Int
		opponentTransferCost: Int
		opponentOverallRank: Int
		opponentChip: Chip
	}

	extend type Query {
		entryTournaments(entryId: Int!): [TournamentInfo!]!
		tournament(tournamentId: Int!, entryId: Int!): TournamentInfo
		managedTournament(tournamentId: Int!, entryId: Int!): TournamentInfo
		tournamentParticipants(tournamentId: Int!): [TournamentParticipant!]!
		tournamentEntryIds(tournamentId: Int!): [Int!]!
		tournamentEventResults(tournamentId: Int!, eventId: Int!): [TournamentEventResult!]!
		tournamentEntryRankingSummary(
			tournamentId: Int!
			eventId: Int!
			entryId: Int!
		): TournamentEntryRankingSummary!
		tournamentBattleGroupResults(tournamentId: Int!, eventId: Int!): [TournamentBattleGroupResult!]!
		entryH2HMatchResults(entryId: Int!): [EntryH2HMatchResult!]!
	}
`;
