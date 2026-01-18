export const playersTypeDefs = /* GraphQL */ `
  enum Position {
    GOALKEEPER
    DEFENDER
    MIDFIELDER
    FORWARD
  }

  type Team {
    id: Int!
    code: Int!
    name: String!
    shortName: String!
    strength: Int!
    position: Int!
    points: Int!
    played: Int!
    win: Int!
    draw: Int!
    loss: Int!
    form: String
    strengthOverallHome: Int!
    strengthOverallAway: Int!
    strengthAttackHome: Int!
    strengthAttackAway: Int!
    strengthDefenceHome: Int!
    strengthDefenceAway: Int!
  }

  type Player {
    id: Int!
    code: Int!
    webName: String!
    firstName: String
    secondName: String
    team: Team!
    position: Position!
    price: Int!
    startPrice: Int!
  }

  input PlayersFilter {
    position: Position
    teamId: Int
    minPrice: Int
    maxPrice: Int
  }

  type PlayerTransferStats {
    player: Player!
    eventId: Int!
    transfersInEvent: Int!
    transfersOutEvent: Int!
  }

  extend type Query {
    player(id: Int!): Player
    players(filter: PlayersFilter, limit: Int = 50, offset: Int = 0): [Player!]!
    team(id: Int!): Team
    teams: [Team!]!
    topTransfersIn(eventId: Int!, limit: Int = 10): [PlayerTransferStats!]!
    topTransfersOut(eventId: Int!, limit: Int = 10): [PlayerTransferStats!]!
  }
`;
