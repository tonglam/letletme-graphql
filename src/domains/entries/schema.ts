export const entriesTypeDefs = /* GraphQL */ `
  enum Chip {
    NONE
    BENCH_BOOST
    FREE_HIT
    TRIPLE_CAPTAIN
    WILDCARD
    MANAGER
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
    eventId: Int!
    eventPoints: Int!
    eventRank: Int
    overallPoints: Int!
    overallRank: Int!
    eventTransfers: Int!
    eventTransfersCost: Int!
    eventNetPoints: Int!
    eventBenchPoints: Int!
    eventChip: Chip!
    eventPlayedCaptain: Player
    eventCaptainPoints: Int!
    eventPicks: [ElementEventResultData!]!
    eventAutoSub: [ElementEventResultData!]!
    teamValue: Int
    bank: Int
  }

  type EntryHistoryInfo {
    season: String!
    totalPoints: Int!
    overallRank: Int!
  }

  type EntryHistoryPayload {
    results: [EntryEventResult!]!
    history: [EntryHistoryInfo!]!
  }

  type EntryGameweekTransfers {
    eventId: Int!
    eventTransfers: Int!
    eventTransfersCost: Int!
    transfers: [EntryEventTransfersData!]!
  }

  extend type Query {
    entry(id: Int!): Entry
    entryHistory(entryId: Int!): EntryHistoryPayload!
    entryEventResult(entryId: Int!, eventId: Int!): EntryEventResult
    entryTransferHistory(entryId: Int!, live: Boolean = false): [EntryGameweekTransfers!]!
  }
`;
