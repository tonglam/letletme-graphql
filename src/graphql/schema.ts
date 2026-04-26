import { makeExecutableSchema } from '@graphql-tools/schema';
import { authResolvers } from '../domains/auth/resolvers';
import { authTypeDefs } from '../domains/auth/schema';
import { entriesResolvers } from '../domains/entries/resolvers';
import { entriesTypeDefs } from '../domains/entries/schema';
import { entryLiveResolvers } from '../domains/entry-live/resolvers';
import { entryLiveTypeDefs } from '../domains/entry-live/schema';
import { eventOverallResultResolvers } from '../domains/event-overall-result/resolvers';
import { eventOverallResultTypeDefs } from '../domains/event-overall-result/schema';
import { eventsResolvers } from '../domains/events/resolvers';
import { eventsTypeDefs } from '../domains/events/schema';
import { fixturesResolvers } from '../domains/fixtures/resolvers';
import { fixturesTypeDefs } from '../domains/fixtures/schema';
import { leaguesResolvers } from '../domains/leagues/resolvers';
import { leaguesTypeDefs } from '../domains/leagues/schema';
import { liveMatchesResolvers } from '../domains/live-matches/resolvers';
import { liveMatchesTypeDefs } from '../domains/live-matches/schema';
import { liveResolvers } from '../domains/live/resolvers';
import { liveTypeDefs } from '../domains/live/schema';
import { playerValuesResolvers } from '../domains/player-values/resolvers';
import { playerValuesTypeDefs } from '../domains/player-values/schema';
import { playersResolvers } from '../domains/players/resolvers';
import { playersTypeDefs } from '../domains/players/schema';
import { tournamentsResolvers } from '../domains/tournaments/resolvers';
import { tournamentsTypeDefs } from '../domains/tournaments/schema';
import { eventStatsResolvers } from '../domains/event-stats/resolvers';
import { eventStatsTypeDefs } from '../domains/event-stats/schema';
import { playerDetailResolvers } from '../domains/player-detail/resolvers';
import { playerDetailTypeDefs } from '../domains/player-detail/schema';
import { baseResolvers, baseTypeDefs } from './base-schema';

export const schema = makeExecutableSchema({
  typeDefs: [
    baseTypeDefs, // Must be first to define Query and Mutation
    authTypeDefs,
    eventsTypeDefs,
    playersTypeDefs,
    playerValuesTypeDefs,
    fixturesTypeDefs,
    liveTypeDefs,
    entryLiveTypeDefs,
    liveMatchesTypeDefs,
    leaguesTypeDefs,
    tournamentsTypeDefs,
    entriesTypeDefs,
    eventOverallResultTypeDefs,
    eventStatsTypeDefs,
    playerDetailTypeDefs,
  ],
  resolvers: [
    baseResolvers,
    authResolvers,
    eventsResolvers,
    playersResolvers,
    playerValuesResolvers,
    fixturesResolvers,
    liveResolvers,
    liveMatchesResolvers,
    entryLiveResolvers,
    leaguesResolvers,
    tournamentsResolvers,
    entriesResolvers,
    eventOverallResultResolvers,
    eventStatsResolvers,
    playerDetailResolvers,
  ],
});
