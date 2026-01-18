export const entriesTypeDefs = /* GraphQL */ `
  enum Chip {
    NONE
    BENCH_BOOST
    FREE_HIT
    TRIPLE_CAPTAIN
    WILDCARD
  }

  type Entry {
    id: Int!
    entryName: String!
    playerName: String!
    region: String
    startedEvent: Int
    overallPoints: Int
    overallRank: Int
    bank: Int
    teamValue: Int
    totalTransfers: Int
  }

  type EntryEventResult {
    entry: Entry!
    event: Event!
    eventPoints: Int!
    eventRank: Int
    overallPoints: Int!
    overallRank: Int!
    eventTransfers: Int!
    eventTransfersCost: Int!
    eventNetPoints: Int!
    teamValue: Int
    bank: Int
  }

  extend type Query {
    entry(id: Int!): Entry
    entryHistory(entryId: Int!): [EntryEventResult!]!
    entryEventResult(entryId: Int!, eventId: Int!): EntryEventResult
  }
`;
