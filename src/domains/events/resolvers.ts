import { DateTimeResolver, JSONResolver } from 'graphql-scalars';
import type { GraphQLContext } from '../../graphql/context';
import type { EventsFilter, Event, CurrentEventInfo } from './repository';
import { eventsService } from './service';

type EventArgs = {
  id: number;
};

type EventsArgs = {
  filter?: EventsFilter | null;
  limit?: number | null;
  offset?: number | null;
};

export const eventsResolvers = {
  DateTime: DateTimeResolver,
  JSON: JSONResolver,
  Query: {
    event: async (
      _parent: unknown,
      args: EventArgs,
      context: GraphQLContext
    ): Promise<Event | null> => eventsService.getEventById(context, args.id),
    events: async (_parent: unknown, args: EventsArgs, context: GraphQLContext): Promise<Event[]> =>
      eventsService.listEvents(
        context,
        args.filter ?? undefined,
        args.limit ?? 50,
        args.offset ?? 0
      ),
    currentEventInfo: async (
      _parent: unknown,
      _args: Record<string, never>,
      context: GraphQLContext
    ): Promise<CurrentEventInfo | null> => eventsService.getCurrentEventInfo(context),
  },
};
