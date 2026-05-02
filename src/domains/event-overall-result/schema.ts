export const eventOverallResultTypeDefs = /* GraphQL */ `
  scalar JSON

  type ChipPlay {
    chipName: String!
    numberPlayed: Int!
  }

  type EventResultPlayer {
    id: Int!
    webName: String!
  }

  type TopElementInfo {
    element: Int!
    points: Int!
    player: Player
    teamShortName: String
  }

  type EventResult {
    event: Int!
    averageScore: Int!
    finished: Boolean!
    highestScoringEntry: Int!
    highestScore: Int!
    chipPlays: [ChipPlay!]!
    mostSelectedPlayer: EventResultPlayer
    mostCaptainedPlayer: EventResultPlayer
    mostTransferInPlayer: EventResultPlayer
    topElementInfo: TopElementInfo!
    transfersMade: Int!
    mostViceCaptainedPlayer: EventResultPlayer
  }

  extend type Query {
    eventOverallResult: [EventResult!]!
  }
`;
