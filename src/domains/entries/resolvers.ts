import type { GraphQLContext } from '../../graphql/context';
import type { Event } from '../events/repository';
import { eventsService } from '../events/service';
import type { Entry, EntryEventResult } from './repository';
import { entriesService } from './service';

type EntryArgs = {
  id: number;
};

type EntryHistoryArgs = {
  entryId: number;
};

type EntryEventResultArgs = {
  entryId: number;
  eventId: number;
};

export const entriesResolvers = {
  Query: {
    entry: async (
      _parent: unknown,
      args: EntryArgs,
      context: GraphQLContext
    ): Promise<Entry | null> => entriesService.getEntryById(context, args.id),

    entryHistory: async (
      _parent: unknown,
      args: EntryHistoryArgs,
      context: GraphQLContext
    ): Promise<EntryEventResult[]> => entriesService.getEntryHistory(context, args.entryId),

    entryEventResult: async (
      _parent: unknown,
      args: EntryEventResultArgs,
      context: GraphQLContext
    ): Promise<EntryEventResult | null> =>
      entriesService.getEntryEventResult(context, args.entryId, args.eventId),
  },
  EntryEventResult: {
    entry: async (
      parent: EntryEventResult,
      _args: Record<string, never>,
      context: GraphQLContext
    ): Promise<Entry | null> => entriesService.getEntryById(context, parent.entryId),
    event: async (
      parent: EntryEventResult,
      _args: Record<string, never>,
      context: GraphQLContext
    ): Promise<Event | null> => eventsService.getEventById(context, parent.eventId),
  },
};
