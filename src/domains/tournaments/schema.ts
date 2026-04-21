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

  extend type Query {
    entryTournaments(entryId: Int!): [TournamentInfo!]!
  }
`;
