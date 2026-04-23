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

  type TournamentInfo {
    id: Int!
    name: String!
    creator: String!
    adminEntryId: Int!
    leagueId: Int!
    leagueType: LeagueType!
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
    createdAt: DateTime!
    updatedAt: DateTime!
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

  extend type Query {
    entryTournaments(entryId: Int!): [TournamentInfo!]!
    tournamentEventResults(tournamentId: Int!, eventId: Int!): [TournamentEventResult!]!
    tournamentEntryRankingSummary(
      tournamentId: Int!
      eventId: Int!
      entryId: Int!
    ): TournamentEntryRankingSummary!
  }
`;
