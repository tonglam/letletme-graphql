export const leaguesTypeDefs = /* GraphQL */ `
  enum LeagueType {
    CLASSIC
    H2H
  }

  type League {
    id: Int!
    name: String!
    type: LeagueType!
    startedEvent: Int
  }

  type LeagueStanding {
    league: League!
    entryId: Int!
    entryName: String
    playerName: String
    rank: Int
    lastRank: Int
    overallPoints: Int!
  }

  type LeagueEventResult {
    league: League!
    event: Event!
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
    leagueStandings(leagueId: Int!, limit: Int = 50): [LeagueStanding!]!
    leagueEventResults(leagueId: Int!, eventId: Int!): [LeagueEventResult!]!
  }
`;
