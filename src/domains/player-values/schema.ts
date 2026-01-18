export const playerValuesTypeDefs = /* GraphQL */ `
  scalar DateTime

  type PlayerValue {
    playerId: Int!
    playerName: String!
    teamId: Int!
    teamName: String!
    position: String!
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

  extend type Query {
    playerValues(changeDate: DateTime): [PlayerValue!]!
  }
`;
