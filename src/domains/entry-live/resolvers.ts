import type { GraphQLContext } from "../../graphql/context";
import type { Entry } from "../entries/repository";
import { entriesService } from "../entries/service";
import type { Event } from "../events/repository";
import { eventsService } from "../events/service";
import { fixturesService } from "../fixtures/service";
import { liveRepository } from "../live/repository";
import { withLiveSnapshotConsistency, withLiveSnapshotRoot } from "../live/snapshot-meta";
import { playersRepository } from "../players/repository";
import { assertTournamentStandingsReady, tournamentsService } from "../tournaments/service";
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
	includeLive?: boolean | null;
};

type CalcLivePointsForEntriesArgs = {
	eventId: number;
	entryIds: number[];
	includeLive?: boolean | null;
};

type CalcLivePointsForTournamentArgs = {
	eventId: number;
	tournamentId: number;
	includeLive?: boolean | null;
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
			withLiveSnapshotRoot(context, () =>
				entryLiveCalcService.calcLivePointsByEntry(
					context,
					args.eventId,
					args.entryId,
					args.includeLive ?? true
				)
			),

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
				const includeLive = args.includeLive ?? true;
				const calculate = (): Promise<BatchLiveCalcResult> =>
					entryLiveBatchService.calcLivePointsForEntries(
						context,
						args.eventId,
						args.entryIds,
						includeLive
					);
				const result = await (includeLive
					? withLiveSnapshotConsistency(context, args.eventId, calculate)
					: calculate());
				return {
					results: Array.from(result.results.values()),
					errors: result.errors,
					meta: result.meta,
				};
			}),

		calcLivePointsForTournament: async (
			_parent: unknown,
			args: CalcLivePointsForTournamentArgs,
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
				await assertTournamentStandingsReady(context, args.tournamentId);
				const includeLive = args.includeLive ?? true;
				const entryIds = await tournamentsService.getTournamentEntryIdsUncached(
					context,
					args.tournamentId
				);
				assertValidEntryBatch(entryIds);

				const calculate = (): Promise<BatchLiveCalcResult> => {
					// Create fresh shared reads for a rare revision retry; reusing already
					// resolved promises would preserve the mixed revision we detected.
					const liveByPlayerPromise =
						includeLive && entryIds.length > 1
							? liveRepository.getAllLivePerformances(context, args.eventId)
							: undefined;
					return entryLiveBatchService.calcLivePointsForEntries(
						context,
						args.eventId,
						entryIds,
						includeLive,
						{
							liveByPlayer: liveByPlayerPromise,
							fixtures: fixturesService.getEventFixtures(context, args.eventId),
							teams: playersRepository.listTeams(context),
						}
					);
				};

				const result = await (includeLive
					? withLiveSnapshotConsistency(context, args.eventId, calculate)
					: calculate());
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
