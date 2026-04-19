import type { GraphQLContext } from '../../graphql/context';
import type { Event } from '../events/repository';
import { eventsService } from '../events/service';
import type { Entry, EntryEventResult } from '../entries/repository';
import { entriesService } from '../entries/service';

export type EntryLive = {
  entry: Entry;
  event: Event;
  eventPoints: number;
  eventRank: number | null;
  overallPoints: number;
  overallRank: number;
  eventTransfers: number;
  eventTransfersCost: number;
  eventNetPoints: number;
  previousOverallPoints: number | null;
  previousOverallRank: number | null;
  liveTotalPoints: number;
};

type RequiredEntryEventResult = Pick<
  EntryEventResult,
  | 'entryId'
  | 'eventId'
  | 'eventPoints'
  | 'eventRank'
  | 'overallPoints'
  | 'overallRank'
  | 'eventTransfers'
  | 'eventTransfersCost'
  | 'eventNetPoints'
>;

const toEntryLive = (params: {
  entry: Entry;
  event: Event;
  current: RequiredEntryEventResult;
  previous: EntryEventResult | null;
}): EntryLive => {
  const previousOverallPoints = params.previous?.overallPoints ?? null;
  const previousOverallRank = params.previous?.overallRank ?? null;
  const liveTotalPoints =
    (previousOverallPoints ?? 0) + params.current.eventNetPoints;

  return {
    entry: params.entry,
    event: params.event,
    eventPoints: params.current.eventPoints,
    eventRank: params.current.eventRank,
    overallPoints: params.current.overallPoints,
    overallRank: params.current.overallRank,
    eventTransfers: params.current.eventTransfers,
    eventTransfersCost: params.current.eventTransfersCost,
    eventNetPoints: params.current.eventNetPoints,
    previousOverallPoints,
    previousOverallRank,
    liveTotalPoints,
  };
};

export const entryLiveService = {
  async getEntryLive(
    context: GraphQLContext,
    entryId: number,
    eventId: number,
  ): Promise<EntryLive | null> {
    if (!Number.isInteger(entryId) || !Number.isInteger(eventId)) {
      return null;
    }

    if (entryId <= 0 || eventId <= 0) {
      return null;
    }

    const [entry, currentResult, previousResult, event] = await Promise.all([
      entriesService.getEntryById(context, entryId),
      entriesService.getEntryEventResult(context, entryId, eventId),
      eventId > 1
        ? entriesService.getEntryEventResult(context, entryId, eventId - 1)
        : Promise.resolve<EntryEventResult | null>(null),
      eventsService.getEventById(context, eventId),
    ]);

    if (!entry || !currentResult || !event) {
      return null;
    }

    return toEntryLive({
      entry,
      event,
      current: currentResult,
      previous: previousResult,
    });
  },
};

