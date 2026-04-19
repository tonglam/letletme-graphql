import type { GraphQLContext } from '../../graphql/context';
import type { Fixture } from '../fixtures/repository';
import { fixturesRepository } from '../fixtures/repository';

export type MatchPlayStatus = 'NEXT_EVENT' | 'NOT_STARTED' | 'PLAYING' | 'FINISHED';

/**
 * Determines the play status of a fixture based on started/finished flags.
 */
const getFixturePlayStatus = (fixture: Fixture): MatchPlayStatus => {
  if (fixture.finished) {
    return 'FINISHED';
  }
  if (fixture.started === true) {
    return 'PLAYING';
  }
  if (fixture.started === false) {
    return 'NOT_STARTED';
  }
  // Default to NOT_STARTED if started is null
  return 'NOT_STARTED';
};

/**
 * Gets the current event ID.
 */
const getCurrentEventId = async (context: GraphQLContext): Promise<number | null> => {
  const { data, error } = await context.supabase
    .from('events')
    .select('id')
    .eq('is_current', true)
    .limit(1);

  if (error) {
    context.logger.error({ err: error }, 'Failed to fetch current event');
    return null;
  }

  return (data?.[0] as { id: number } | undefined)?.id ?? null;
};

interface LiveMatchesRepository {
  getFixturesByStatus(
    context: GraphQLContext,
    status: MatchPlayStatus,
  ): Promise<Fixture[]>;
}

/**
 * Helper to safely get event fixtures with proper type assertion.
 * Supabase client types surface `any` internally; we contain it here.
 */
const getEventFixturesSafe = async (
  context: GraphQLContext,
  eventId: number,
): Promise<Fixture[]> => {
  const fixtures = await fixturesRepository.getEventFixtures(context, eventId);
  return fixtures as Fixture[];
};

export const liveMatchesRepository: LiveMatchesRepository = {
  async getFixturesByStatus(
    context: GraphQLContext,
    status: MatchPlayStatus,
  ): Promise<Fixture[]> {
    if (status === 'NEXT_EVENT') {
      // Get next event's fixtures
      const currentEventId = await getCurrentEventId(context);
      if (!currentEventId || currentEventId > 38) {
        return [];
      }
      const nextEventId = currentEventId + 1;
      return getEventFixturesSafe(context, nextEventId);
    }

    // For other statuses, get current event fixtures and filter
    const currentEventId = await getCurrentEventId(context);
    if (!currentEventId) {
      return [];
    }

    const allFixtures = await getEventFixturesSafe(context, currentEventId);

    // Filter fixtures by status
    return allFixtures.filter((fixture) => getFixturePlayStatus(fixture) === status);
  },
};
