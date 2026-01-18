export const liveTypeDefs = /* GraphQL */ `
  type LivePerformance {
    event: Event!
    player: Player!
    minutes: Int
    goalsScored: Int
    assists: Int
    cleanSheets: Int
    goalsConceded: Int
    ownGoals: Int
    penaltiesSaved: Int
    penaltiesMissed: Int
    yellowCards: Int
    redCards: Int
    saves: Int
    bonus: Int
    bps: Int
    starts: Boolean
    expectedGoals: Float
    expectedAssists: Float
    expectedGoalInvolvements: Float
    expectedGoalsConceded: Float
    inDreamTeam: Boolean
    totalPoints: Int!
  }

  input LiveScoresFilter {
    inDreamTeam: Boolean
    minTotalPoints: Int
    maxTotalPoints: Int
  }

  type EventLive {
    event: Event!
    performances: [LivePerformance!]!
    dreamTeam: [LivePerformance!]!
    topPerformers(limit: Int = 10): [LivePerformance!]!
  }

  extend type Query {
    liveScores(eventId: Int, filter: LiveScoresFilter): [LivePerformance!]!
    playerLive(playerId: Int!, eventId: Int): LivePerformance
    eventLive(eventId: Int!): EventLive
  }
`;
