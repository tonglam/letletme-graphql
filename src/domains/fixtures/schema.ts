export const fixturesTypeDefs = /* GraphQL */ `
  type Fixture {
    id: Int!
    code: Int!
    event: Event
    finished: Boolean!
    finishedProvisional: Boolean!
    kickoffTime: DateTime
    minutes: Int!
    started: Boolean
    homeTeam: Team!
    awayTeam: Team!
    homeScore: Int
    awayScore: Int
    homeTeamDifficulty: Int
    awayTeamDifficulty: Int
  }

  input FixturesFilter {
    eventId: Int
    teamId: Int
    finished: Boolean
  }

  extend type Query {
    fixture(id: Int!): Fixture
    fixtures(filter: FixturesFilter, limit: Int = 50, offset: Int = 0): [Fixture!]!
    currentFixtures: [Fixture!]!
    eventFixtures(eventId: Int!): [Fixture!]!
  }
`;
