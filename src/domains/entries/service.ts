import type { GraphQLContext } from '../../graphql/context';
import type { Entry, EntryEventResult } from './repository';
import { entriesRepository } from './repository';

export const entriesService = {
  getEntryById(context: GraphQLContext, id: number): Promise<Entry | null> {
    return entriesRepository.getEntryById(context, id);
  },

  getEntryHistory(context: GraphQLContext, entryId: number): Promise<EntryEventResult[]> {
    return entriesRepository.getEntryHistory(context, entryId);
  },

  getEntryEventResult(
    context: GraphQLContext,
    entryId: number,
    eventId: number
  ): Promise<EntryEventResult | null> {
    return entriesRepository.getEntryEventResult(context, entryId, eventId);
  },
};
