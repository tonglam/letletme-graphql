export const eventsTypeDefs = /* GraphQL */ `
  scalar JSON
  scalar DateTime

  type Event {
    id: Int!
    name: String!
    deadlineTime: DateTime
    averageEntryScore: Int
    finished: Boolean!
    dataChecked: Boolean!
    highestScoringEntry: Int
    deadlineTimeEpoch: Int
    deadlineTimeGameOffset: Int
    highestScore: Int
    isPrevious: Boolean!
    isCurrent: Boolean!
    isNext: Boolean!
    cupLeagueCreate: Boolean!
    h2hKoMatchesCreated: Boolean!
    chipPlays: JSON
    mostSelected: Int
    mostTransferredIn: Int
    topElement: Int
    topElementInfo: JSON
    transfersMade: Int
    mostCaptained: Int
    mostViceCaptained: Int
  }

  input EventsFilter {
    isPrevious: Boolean
    isCurrent: Boolean
    isNext: Boolean
    finished: Boolean
    dataChecked: Boolean
  }

  type CurrentEventInfo {
    currentEvent: Int!
    nextUtcDeadline: DateTime
  }

  type Query {
    event(id: Int!): Event
    events(filter: EventsFilter, limit: Int = 50, offset: Int = 0): [Event!]!
    currentEventInfo: CurrentEventInfo
  }
`;
