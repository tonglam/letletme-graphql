export const entryLiveTypeDefs = /* GraphQL */ `
  """
  Summary of an entry's performance for a single event,
  enriched with live-style totals based on historical results.
  """
  type EntryLive {
    entry: Entry!
    event: Event!

    "Raw event result for this entry/event."
    eventPoints: Int!
    eventRank: Int
    overallPoints: Int!
    overallRank: Int!
    eventTransfers: Int!
    eventTransfersCost: Int!
    eventNetPoints: Int!

    "Overall points before this event (from previous event result, if any)."
    previousOverallPoints: Int
    "Overall rank before this event (from previous event result, if any)."
    previousOverallRank: Int

    """
    Convenience field: previousOverallPoints + eventNetPoints.
    Represents a live-style total assuming this event is still in progress.
    """
    liveTotalPoints: Int!
  }

  extend type Query {
    """
    Aggregated view of an entry's performance for a given event.

    This query composes data from the Entries and Events domains
    and is optimized via Redis-backed repositories.
    """
    entryLive(entryId: Int!, eventId: Int!): EntryLive

    """
    Full live calculation for an entry and event.

    This is the GraphQL-native equivalent of the legacy LiveCalcData payload:
    - static data (entry/player/team/fixtures) comes from cached repositories
    - dynamic data (event live points) comes from Live domain (short TTL)
    - calculation is performed server-side for fast client consumption
    """
    calcLivePointsByEntry(eventId: Int!, entryId: Int!): LiveCalcData!

    """
    Batch live calculation for multiple entries in a single event.
    Shares live performance data, fixtures, teams, and players across all entries,
    then computes each entry in parallel with error tolerance.
    """
    calcLivePointsForEntries(eventId: Int!, entryIds: [Int!]!): BatchLiveCalcResult!

    """
    Batch live calculation for all entries in a tournament.
    Resolves entry IDs from the tournament, then computes live points for each.
    """
    calcLivePointsForTournament(eventId: Int!, tournamentId: Int!): BatchLiveCalcResult!
  }

  type LiveCalcData {
    rank: Int!
    event: Int!
    entry: Int!
    entryName: String!
    playerName: String!
    region: String
    startedEvent: Int!
    overallPoints: Int!
    overallRank: Int!
    value: Float!
    bank: Float!
    teamValue: Float!
    totalTransfers: Int!
    lastOverallPoints: Int!
    lastOverallRank: Int!
    lastValue: Float!
    chip: Chip!
    livePoints: Int!
    transferCost: Int!
    liveNetPoints: Int!
    liveTotalPoints: Int!
    played: Int!
    toPlay: Int!
    playedCaptain: Int!
    captainName: String!
    pickList: [ElementEventResultData!]!
    transfersList: [EntryEventTransfersData!]!
  }

  type ElementEventResultData {
    season: String
    event: Int!
    element: Int!
    code: Int!
    webName: String!
    price: Float!
    elementType: Int!
    elementTypeName: String!
    teamId: Int!
    teamCode: Int!
    teamName: String!
    teamShortName: String!
    againstId: Int!
    againstName: String!
    againstShortName: String!
    wasHome: String!
    score: String!
    position: Int!
    multiplier: Int!
    isCaptain: Boolean!
    isViceCaptain: Boolean!
    isGwStarted: Boolean!
    isGwFinished: Boolean!
    isPlayed: Boolean!
    playStatus: Int!
    minutes: Int!
    goalsScored: Int!
    assists: Int!
    cleanSheets: Int!
    goalsConceded: Int!
    defensiveContribution: Int!
    ownGoals: Int!
    penaltiesSaved: Int!
    penaltiesMissed: Int!
    yellowCards: Int!
    redCards: Int!
    saves: Int!
    bonus: Int!
    bps: Int!
    totalPoints: Int!
    starts: Boolean
    expectedGoals: Float
    expectedAssists: Float
    expectedGoalInvolvements: Float
    expectedGoalsConceded: Float
    inDreamTeam: Boolean
    pickActive: Boolean!
    autoSub: Boolean!
    bgw: Boolean!
    dgw: Boolean!
  }

  type EntryEventTransfersData {
    event: Int!
    entry: Int!
    elementIn: Int!
    elementInWebName: String!
    elementInType: Int!
    elementInTypeName: String!
    elementInTeamId: Int!
    elementInTeamName: String!
    elementInTeamShortName: String!
    elementInCost: Float!
    elementInPoints: Int!
    elementInPlayed: Boolean!
    elementOut: Int!
    elementOutWebName: String!
    elementOutTeamId: Int!
    elementOutTeamName: String!
    elementOutTeamShortName: String!
    elementOutType: Int!
    elementOutTypeName: String!
    elementOutCost: Float!
    elementOutPoints: Int!
    time: String!
  }

  type BatchLiveCalcResult {
    results: [LiveCalcData!]!
    errors: [EntryCalcError!]!
    meta: BatchCalcMeta!
  }

  type EntryCalcError {
    entryId: Int!
    message: String!
  }

  type BatchCalcMeta {
    eventId: Int!
    totalEntries: Int!
    succeededCount: Int!
    failedCount: Int!
  }
`;

