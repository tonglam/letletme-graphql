export const eventOverallResultTypeDefs = /* GraphQL */ `
  scalar JSON

  type ChipPlay {
    chipName: String!
    numberPlayed: Int!
  }

  type TopElementInfo {
    element: Int!
    points: Int!
    player: Player
  }

  type EventResult {
    event: Int!
    averageEntryScore: Int!
    finished: Boolean!
    highestScoringEntry: Int!
    highestScore: Int!
    chipPlays: [ChipPlay!]!
    mostSelected: Int!
    mostSelectedPlayer: Player
    mostTransferredIn: Int!
    mostTransferredInPlayer: Player
    topElementInfo: TopElementInfo!
    transfersMade: Int!
    mostCaptained: Int!
    mostCaptainedPlayer: Player
    mostViceCaptained: Int!
    mostViceCaptainedPlayer: Player
  }

  extend type Query {
    eventOverallResult(season: Int!): [EventResult!]!
  }
`;
