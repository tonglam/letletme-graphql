import type { GraphQLContext } from "../../graphql/context";
import type { ElementEventResultData } from "../entry-live/calc-service";
import type { Player } from "../players/repository";
import { playersService } from "../players/service";
import type { Entry, EntryEventResult, EntryHistoryInfo } from "./repository";
import type { EntryGameweekTransfers } from "./service";
import { entriesService } from "./service";

/**
 * Per-request memoization for player-event lookups to avoid N+1 Redis/DB round-trips
 * when resolving the `eventPlayedCaptain` field on multiple EntryEventResult rows.
 */
const playersForEventMemo = new WeakMap<
	GraphQLContext,
	Map<string, Player | null>
>();

const getPlayerByIdForEventMemoized = async (
	context: GraphQLContext,
	playerId: number,
	eventId: number,
): Promise<Player | null> => {
	const key = `${playerId}:${eventId}`;
	let memo = playersForEventMemo.get(context);
	if (!memo) {
		memo = new Map();
		playersForEventMemo.set(context, memo);
	}
	const cached = memo.get(key);
	if (cached !== undefined) {
		return cached;
	}
	const player = await playersService.getPlayerByIdForEvent(
		context,
		playerId,
		eventId,
	);
	memo.set(key, player);
	return player;
};

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

type EntryTransferHistoryArgs = {
	entryId: number;
};

type EntryHistoryPayload = {
	results: EntryEventResult[];
	history: EntryHistoryInfo[];
};

export const entryResultChipToEnum = (raw: string | null): string => {
	if (raw === null) {
		return "NONE";
	}

	const value = raw.toUpperCase().trim();
	const compactValue = value.replace(/[^A-Z0-9]/g, "");
	if (
		value === "BENCH_BOOST" ||
		compactValue === "BENCHBOOST" ||
		compactValue === "BBOOST" ||
		compactValue === "BB"
	) {
		return "BENCH_BOOST";
	}
	if (
		value === "TRIPLE_CAPTAIN" ||
		compactValue === "TRIPLECAPTAIN" ||
		compactValue === "3XC" ||
		compactValue === "TC"
	) {
		return "TRIPLE_CAPTAIN";
	}
	if (
		value === "FREE_HIT" ||
		compactValue === "FREEHIT" ||
		compactValue === "FH"
	) {
		return "FREE_HIT";
	}
	if (
		value === "WILDCARD" ||
		compactValue === "WILDCARD" ||
		compactValue === "WC"
	) {
		return "WILDCARD";
	}
	if (
		value === "MANAGER" ||
		compactValue === "MANAGER" ||
		compactValue === "AM"
	) {
		return "MANAGER";
	}
	return "NONE";
};

export const entriesResolvers = {
	Query: {
		entry: async (
			_parent: unknown,
			args: EntryArgs,
			context: GraphQLContext,
		): Promise<Entry | null> => entriesService.getEntryById(context, args.id),

		entryHistory: async (
			_parent: unknown,
			args: EntryHistoryArgs,
			context: GraphQLContext,
		): Promise<EntryHistoryPayload> => {
			const [results, history] = await Promise.all([
				entriesService.getEntryHistory(context, args.entryId),
				entriesService.getEntryHistoryInfo(context, args.entryId),
			]);
			return { results, history };
		},

		entryEventResult: async (
			_parent: unknown,
			args: EntryEventResultArgs,
			context: GraphQLContext,
		): Promise<EntryEventResult | null> =>
			entriesService.getEntryEventResult(context, args.entryId, args.eventId),

		entryTransferHistory: async (
			_parent: unknown,
			args: EntryTransferHistoryArgs,
			context: GraphQLContext,
		): Promise<EntryGameweekTransfers[]> =>
			entriesService.getEntryTransferHistory(context, args.entryId),
	},
	EntryEventResult: {
		entry: async (
			parent: EntryEventResult,
			_args: Record<string, never>,
			context: GraphQLContext,
		): Promise<Entry | null> =>
			entriesService.getEntryById(context, parent.entryId),
		eventBenchPoints: (parent: EntryEventResult): number =>
			parent.eventBenchPoints,
		eventChip: (parent: EntryEventResult): string =>
			entryResultChipToEnum(parent.eventChip),
		eventPlayedCaptain: async (
			parent: EntryEventResult,
			_args: Record<string, never>,
			context: GraphQLContext,
		): Promise<Player | null> => {
			if (
				parent.eventPlayedCaptain === null ||
				parent.eventPlayedCaptain <= 0
			) {
				return null;
			}
			return getPlayerByIdForEventMemoized(
				context,
				parent.eventPlayedCaptain,
				parent.eventId,
			);
		},
		eventCaptainPoints: (parent: EntryEventResult): number =>
			parent.eventCaptainPoints,
		eventPicks: (
			parent: EntryEventResult,
			_args: Record<string, never>,
			context: GraphQLContext,
		): Promise<ElementEventResultData[]> =>
			entriesService.getEntryEventPicks(context, parent),
		eventAutoSub: async (
			parent: EntryEventResult,
			_args: Record<string, never>,
			context: GraphQLContext,
		): Promise<ElementEventResultData[]> =>
			(await entriesService.getEntryEventPicks(context, parent)).filter(
				(pick) => pick.autoSub,
			),
	},
};
