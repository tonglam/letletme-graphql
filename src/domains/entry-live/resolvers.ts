import type { GraphQLContext } from '../../graphql/context';
import type { Entry } from '../entries/repository';
import { entriesService } from '../entries/service';
import type { Event } from '../events/repository';
import { eventsService } from '../events/service';
import type { LiveCalcData } from './calc-service';
import { entryLiveCalcService } from './calc-service';
import type { EntryLive as EntryLiveModel } from './service';
import { entryLiveService } from './service';

type EntryLiveArgs = {
  entryId: number;
  eventId: number;
};

type CalcLivePointsByEntryArgs = {
  eventId: number;
  entryId: number;
};

export const entryLiveResolvers = {
  Query: {
    entryLive: async (
      _parent: unknown,
      args: EntryLiveArgs,
      context: GraphQLContext,
    ): Promise<EntryLiveModel | null> =>
      entryLiveService.getEntryLive(context, args.entryId, args.eventId),

    calcLivePointsByEntry: async (
      _parent: unknown,
      args: CalcLivePointsByEntryArgs,
      context: GraphQLContext
    ): Promise<LiveCalcData> =>
      entryLiveCalcService.calcLivePointsByEntry(context, args.eventId, args.entryId),
  },
  EntryLive: {
    entry: async (
      parent: EntryLiveModel,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<Entry | null> => entriesService.getEntryById(context, parent.entry.id),
    event: async (
      parent: EntryLiveModel,
      _args: Record<string, never>,
      context: GraphQLContext,
    ): Promise<Event | null> => eventsService.getEventById(context, parent.event.id),
  },
};

