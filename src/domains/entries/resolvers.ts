import { GraphQLError } from "graphql";
import { normalizeFplChip } from "../../contracts/fpl-chip";
import type { GraphQLContext } from "../../graphql/context";
import type { ElementEventResultDataV2 as ElementEventResultData } from "../entry-live/v2-service";
import type { Player } from "../players/repository";
import { playersService } from "../players/service";
import type { Entry, EntryEventResult, EntryHistoryInfo, EntryNameUsage } from "./repository";
import {
	SEARCH_ENTRIES_DEFAULT_LIMIT,
	SEARCH_ENTRIES_MAX_LIMIT,
	SEARCH_ENTRIES_MAX_QUERY_LENGTH,
	SEARCH_ENTRIES_MIN_QUERY_LENGTH,
} from "./repository";
import type { EntryGameweekTransfers, EntryLookupResult } from "./service";
import { entriesService } from "./service";

/**
 * Per-request memoization for player-event lookups to avoid N+1 Redis/DB round-trips
 * when resolving the `eventPlayedCaptain` field on multiple EntryEventResult rows.
 */
const playersForEventMemo = new WeakMap<GraphQLContext, Map<string, Player | null>>();

const entryEventPicksMemo = new WeakMap<
	object,
	Map<EntryEventResult, Promise<ElementEventResultData[]>>
>();

const getEntryEventPicksMemoized = (
	context: GraphQLContext,
	parent: EntryEventResult
): Promise<ElementEventResultData[]> => {
	const scope = context.requestScope ?? context;
	let memo = entryEventPicksMemo.get(scope);
	if (!memo) {
		memo = new Map();
		entryEventPicksMemo.set(scope, memo);
	}
	const cached = memo.get(parent);
	if (cached) return cached;
	const pending = entriesService.getEntryEventPicks(context, parent);
	memo.set(parent, pending);
	void pending.catch(() => {
		if (memo?.get(parent) === pending) memo.delete(parent);
	});
	return pending;
};

const getPlayerByIdForEventMemoized = async (
	context: GraphQLContext,
	playerId: number,
	eventId: number
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
	const player = await playersService.getPlayerByIdForEvent(context, playerId, eventId);
	memo.set(key, player);
	return player;
};

type EntryArgs = {
	id: number;
};

type SearchEntriesArgs = {
	query: string;
	limit?: number | null;
};

type EntryHistoryArgs = {
	entryId: number;
};

type EntryNameUsageArgs = {
	entryId: number;
};

type EntryEventResultArgs = {
	entryId: number;
	eventId: number;
};

type EntryTransferHistoryArgs = {
	entryId: number;
	live: boolean;
};

type EntryHistoryPayload = {
	results: EntryEventResult[];
	history: EntryHistoryInfo[];
};

export const normalizeEntrySearchQuery = (query: string): string => {
	const normalized = query.trim();
	if (
		normalized.length < SEARCH_ENTRIES_MIN_QUERY_LENGTH ||
		normalized.length > SEARCH_ENTRIES_MAX_QUERY_LENGTH
	) {
		throw new GraphQLError(
			`Entry search must be ${SEARCH_ENTRIES_MIN_QUERY_LENGTH}-${SEARCH_ENTRIES_MAX_QUERY_LENGTH} characters`,
			{ extensions: { code: "BAD_USER_INPUT" } }
		);
	}
	return normalized;
};

export const normalizeEntrySearchLimit = (limit: number | null | undefined): number => {
	const normalized = limit ?? SEARCH_ENTRIES_DEFAULT_LIMIT;
	if (!Number.isInteger(normalized) || normalized < 1 || normalized > SEARCH_ENTRIES_MAX_LIMIT) {
		throw new GraphQLError(`limit must be an integer between 1 and ${SEARCH_ENTRIES_MAX_LIMIT}`, {
			extensions: { code: "BAD_USER_INPUT" },
		});
	}
	return normalized;
};

export const entryResultChipToEnum = (raw: string | null): string =>
	normalizeFplChip(raw, "NONE") ?? "NONE";

export const entriesResolvers = {
	Query: {
		entryLookup: async (
			_parent: unknown,
			args: EntryArgs,
			context: GraphQLContext
		): Promise<EntryLookupResult> => entriesService.lookupEntryById(context, args.id),

		entrySnapshot: async (
			_parent: unknown,
			args: EntryArgs,
			context: GraphQLContext
		): Promise<Entry | null> => entriesService.getEntrySnapshot(context, args.id),

		entryNameUsage: async (
			_parent: unknown,
			args: EntryNameUsageArgs,
			context: GraphQLContext
		): Promise<EntryNameUsage | null> => entriesService.getEntryNameUsage(context, args.entryId),

		searchEntries: async (
			_parent: unknown,
			args: SearchEntriesArgs,
			context: GraphQLContext
		): Promise<Entry[]> =>
			entriesService.searchEntries(
				context,
				normalizeEntrySearchQuery(args.query),
				normalizeEntrySearchLimit(args.limit)
			),

		entryHistory: async (
			_parent: unknown,
			args: EntryHistoryArgs,
			context: GraphQLContext
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
			context: GraphQLContext
		): Promise<EntryEventResult | null> =>
			entriesService.getEntryEventResult(context, args.entryId, args.eventId),

		entryTransferHistory: async (
			_parent: unknown,
			args: EntryTransferHistoryArgs,
			context: GraphQLContext
		): Promise<EntryGameweekTransfers[]> =>
			entriesService.getEntryTransferHistory(context, args.entryId, args.live),
	},
	EntryEventResult: {
		entry: async (
			parent: EntryEventResult,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<Entry | null> => entriesService.getEntryById(context, parent.entryId),
		eventBenchPoints: (parent: EntryEventResult): number => parent.eventBenchPoints,
		eventChip: (parent: EntryEventResult): string => entryResultChipToEnum(parent.eventChip),
		eventPlayedCaptain: async (
			parent: EntryEventResult,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<Player | null> => {
			if (parent.eventPlayedCaptain === null || parent.eventPlayedCaptain <= 0) {
				return null;
			}
			return getPlayerByIdForEventMemoized(context, parent.eventPlayedCaptain, parent.eventId);
		},
		eventCaptainPoints: (parent: EntryEventResult): number => parent.eventCaptainPoints,
		eventPicks: (
			parent: EntryEventResult,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<ElementEventResultData[]> => getEntryEventPicksMemoized(context, parent),
		eventAutoSub: async (
			parent: EntryEventResult,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<ElementEventResultData[]> =>
			(await getEntryEventPicksMemoized(context, parent)).filter((pick) => pick.autoSub),
	},
};
