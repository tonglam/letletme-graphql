export const playerValuesTypeDefs = /* GraphQL */ `
  scalar DateTime
  scalar Date

  enum PriceChangeType {
    RISE
    FALL
    UNCHANGED
  }

  type PlayerValue {
    playerId: Int!
    playerName: String!
    teamId: Int!
    teamName: String!
    teamShortName: String!
    position: String!
    positionEnum: Position
    price: Int!
    value: Float!
    lastValue: Float!
    points: Int!
    selectedBy: Float!
    transfersIn: Int!
    transfersOut: Int!
    netTransfers: Int!
    form: Float
    totalPoints: Int!
    eventPoints: Int
  }

  type PlayerValueHistoryItem {
    playerId: Int!
    changeDate: DateTime!
    oldValue: Int!
    newValue: Int!
    changeType: PriceChangeType!
    transfersIn: Int
    transfersOut: Int
  }

  extend type Query {
    playerValues(changeDate: Date!): [PlayerValue!]!
    playerValueHistory(
      playerId: Int!
      fromDate: DateTime
      toDate: DateTime
    ): [PlayerValueHistoryItem!]!
  }
`;
