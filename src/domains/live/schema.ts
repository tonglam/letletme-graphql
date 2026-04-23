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
    defensiveContribution: Int
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

  type LiveExplainStatContribution {
    identifier: String!
    points: Int!
    value: Float
    pointsModification: Int
  }

  type LiveExplainBreakdown {
    fixtureId: Int!
    stats: [LiveExplainStatContribution!]!
  }

  type LiveExplainStats {
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
    influence: Float
    creativity: Float
    threat: Float
    ictIndex: Float
    clearancesBlocksInterceptions: Int
    recoveries: Int
    tackles: Int
    defensiveContribution: Int
    starts: Int
    expectedGoals: Float
    expectedAssists: Float
    expectedGoalInvolvements: Float
    expectedGoalsConceded: Float
    totalPoints: Int
    inDreamTeam: Boolean
  }

  type LiveExplain {
    event: Event!
    eventId: Int!
    player: Player
    elementId: Int!
    modified: Boolean
    selectedBy: Float
    stats: LiveExplainStats!
    breakdown: [LiveExplainBreakdown!]!
  }

  extend type Query {
    liveScores(eventId: Int, filter: LiveScoresFilter): [LivePerformance!]!
    playerLive(playerId: Int!, eventId: Int): LivePerformance
    eventLive(eventId: Int!): EventLive
    eventLiveExplain(eventId: Int!, elementId: Int!): LiveExplain
  }
`;
