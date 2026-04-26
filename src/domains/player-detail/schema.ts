export const playerDetailTypeDefs = /* GraphQL */ `
  type PlayerDetail {
    id: Int!
    webName: String!
    teamShortName: String!
    elementType: Int!
    elementTypeName: String!
    price: Float!
    startPrice: Float!
    totalPoints: Int!

    selectedByPercent: Float
    form: Float
    seasonTransfersIn: Int!
    seasonTransfersOut: Int!
    transfersInEvent: Int!
    transfersOutEvent: Int!

    eventPoints: Int
    minutes: Int
    goalsScored: Int
    assists: Int
    cleanSheets: Int
    goalsConceded: Int
    ownGoals: Int
    penaltiesSaved: Int
    yellowCards: Int
    redCards: Int
    saves: Int
    bonus: Int
    bps: Int

    influence: Float
    creativity: Float
    threat: Float
    ictIndex: Float

    fixtures: [PlayerFixture!]!
  }

  type PlayerFixture {
    event: Int!
    againstTeamShortName: String!
    wasHome: Boolean!
    finished: Boolean!
    kickoffTime: String
    score: String
    difficulty: Int!
    bgw: Boolean!
  }

  extend type Query {
    playerDetail(
      playerId: Int!
      eventId: Int!
    ): PlayerDetail
  }
`;
