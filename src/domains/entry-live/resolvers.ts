import type { GraphQLContext } from "../../graphql/context";
import type { Entry } from "../entries/repository";
import { entriesService } from "../entries/service";
import type { Event } from "../events/repository";
import { eventsService } from "../events/service";
import { withLiveSnapshotRoot } from "../live/snapshot-meta";
import {
	assertValidEntryBatch,
	entryLiveBatchService,
	type BatchLiveCalcResult,
} from "./batch-service";
import type { LiveCalcData } from "./calc-service";
import { entryLiveCalcService } from "./calc-service";
import type { EntryLive as EntryLiveModel } from "./service";
import { entryLiveService } from "./service";

type EntryLiveArgs = {
	entryId: number;
	eventId: number;
};

type CalcLivePointsByEntryArgs = {
	eventId: number;
	entryId: number;
};

type CalcLivePointsForEntriesArgs = {
	eventId: number;
	entryIds: number[];
};

export const entryLiveResolvers = {
	Query: {
		entryLive: async (
			_parent: unknown,
			args: EntryLiveArgs,
			context: GraphQLContext
		): Promise<EntryLiveModel | null> =>
			entryLiveService.getEntryLive(context, args.entryId, args.eventId),

		calcLivePointsByEntry: async (
			_parent: unknown,
			args: CalcLivePointsByEntryArgs,
			context: GraphQLContext
		): Promise<LiveCalcData> =>
			entryLiveCalcService.calcLivePointsByEntry(context, args.eventId, args.entryId),

		calcLivePointsForEntries: async (
			_parent: unknown,
			args: CalcLivePointsForEntriesArgs,
			context: GraphQLContext
		): Promise<{
			results: LiveCalcData[];
			errors: Array<{ entryId: number; message: string }>;
			meta: {
				eventId: number;
				totalEntries: number;
				succeededCount: number;
				failedCount: number;
			};
		}> =>
			withLiveSnapshotRoot(context, async () => {
				assertValidEntryBatch(args.entryIds);
				const calculate = (): Promise<BatchLiveCalcResult> =>
					entryLiveBatchService.calcLivePointsForEntries(context, args.eventId, args.entryIds);
				const result = await calculate();
				return {
					results: Array.from(result.results.values()),
					errors: result.errors,
					meta: result.meta,
				};
			}),
	},
	EntryLive: {
		entry: async (
			parent: EntryLiveModel,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<Entry | null> => entriesService.getEntryById(context, parent.entry.id),
		event: async (
			parent: EntryLiveModel,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<Event | null> => eventsService.getEventById(context, parent.event.id),
	},
};
