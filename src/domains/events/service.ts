import type { GraphQLContext } from '../../graphql/context';
import type { EventsFilter, Event, CurrentEventInfo } from './repository';
import { eventsRepository } from './repository';

export const eventsService = {
  getEventById: (context: GraphQLContext, id: number): Promise<Event | null> =>
    eventsRepository.getEventById(context, id),
  listEvents: (
    context: GraphQLContext,
    filter: EventsFilter | null | undefined,
    limit: number,
    offset: number
  ): Promise<Event[]> => eventsRepository.listEvents(context, filter, limit, offset),
  getCurrentEventInfo: (context: GraphQLContext): Promise<CurrentEventInfo | null> =>
    eventsRepository.getCurrentEventInfo(context),
};
