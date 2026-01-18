import type { GraphQLContext } from '../../graphql/context';
import type { Fixture, FixturesFilter } from './repository';
import { fixturesRepository } from './repository';

export const fixturesService = {
  getFixtureById(context: GraphQLContext, id: number): Promise<Fixture | null> {
    return fixturesRepository.getFixtureById(context, id);
  },

  listFixtures(
    context: GraphQLContext,
    filter: FixturesFilter | null | undefined,
    limit: number,
    offset: number
  ): Promise<Fixture[]> {
    return fixturesRepository.listFixtures(context, filter, limit, offset);
  },

  getCurrentFixtures(context: GraphQLContext): Promise<Fixture[]> {
    return fixturesRepository.getCurrentFixtures(context);
  },
};
