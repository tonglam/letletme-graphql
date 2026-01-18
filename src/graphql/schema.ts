import { makeExecutableSchema } from '@graphql-tools/schema';
import { authResolvers } from '../domains/auth/resolvers';
import { authTypeDefs } from '../domains/auth/schema';
import { entriesResolvers } from '../domains/entries/resolvers';
import { entriesTypeDefs } from '../domains/entries/schema';
import { eventOverallResultResolvers } from '../domains/event-overall-result/resolvers';
import { eventOverallResultTypeDefs } from '../domains/event-overall-result/schema';
import { eventsResolvers } from '../domains/events/resolvers';
import { eventsTypeDefs } from '../domains/events/schema';
import { fixturesResolvers } from '../domains/fixtures/resolvers';
import { fixturesTypeDefs } from '../domains/fixtures/schema';
import { leaguesResolvers } from '../domains/leagues/resolvers';
import { leaguesTypeDefs } from '../domains/leagues/schema';
import { liveResolvers } from '../domains/live/resolvers';
import { liveTypeDefs } from '../domains/live/schema';
import { playerValuesResolvers } from '../domains/player-values/resolvers';
import { playerValuesTypeDefs } from '../domains/player-values/schema';
import { playersResolvers } from '../domains/players/resolvers';
import { playersTypeDefs } from '../domains/players/schema';
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
    leaguesTypeDefs,
    entriesTypeDefs,
    eventOverallResultTypeDefs,
  ],
  resolvers: [
    baseResolvers,
    authResolvers,
    eventsResolvers,
    playersResolvers,
    playerValuesResolvers,
    fixturesResolvers,
    liveResolvers,
    leaguesResolvers,
    entriesResolvers,
    eventOverallResultResolvers,
  ],
});
