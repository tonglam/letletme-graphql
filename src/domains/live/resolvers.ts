import type { GraphQLResolveInfo } from "graphql";
import { GraphQLError } from "graphql";

import { measureRequestStage } from "../../http/request-timing";
import type { GraphQLContext } from "../../graphql/context";
import {
	directSelectionRequestsField,
	parentSelectionRequestsField,
} from "../../graphql/selection-set";
import { getCurrentEventId } from "../../infra/event";
import { getCoreLiveIdentitySnapshot } from "../../infra/data-snapshot";
import type { LivePerformanceData } from "../../infra/live-types";
import type { Event } from "../events/repository";
import { eventsService } from "../events/service";
import type { Player } from "../players/repository";
import { playersService } from "../players/service";
import {
	loadLiveSnapshotMetaV2,
	readLivePublicationV2,
	type LiveSnapshotMetaV2,
} from "../entry-live/v2-service";

type LiveScoresFilter = {
	inDreamTeam?: boolean | null;
	minTotalPoints?: number | null;
	maxTotalPoints?: number | null;
};

type LivePerformance = LivePerformanceData;
type EventLive = { eventId: number; performances: LivePerformance[] };
type LiveExplainContribution = {
	identifier: string;
	points: number;
	value: number | null;
	pointsModification: number | null;
};
type LiveExplain = {
	eventId: number;
	elementId: number;
	modified: boolean | null;
	stats: Record<string, number | boolean | null>;
	breakdown: Array<{ fixtureId: number; stats: LiveExplainContribution[] }>;
	contributions?: LiveExplainContribution[];
	selectedBy: number | null;
};

/**
 * These roots are deliberately projections of the same immutable V2 event
 * publication used by entry live points. They do not call Data HTTP, FPL, a
 * manager resolver, or a queue.
 */

const playersMemo = new WeakMap<GraphQLContext, Map<number, Player | null>>();
const eventsMemo = new WeakMap<GraphQLContext, Map<number, Event | null>>();

const getPlayerByIdMemoized = async (
	context: GraphQLContext,
	playerId: number
): Promise<Player | null> => {
	const bulk = context.playersByIdPreload;
	if (bulk?.has(playerId)) return bulk.get(playerId) ?? null;

	let memo = playersMemo.get(context);
	if (!memo) {
		memo = new Map();
		playersMemo.set(context, memo);
	}
	if (memo.has(playerId)) return memo.get(playerId) ?? null;
	try {
		const player = await playersService.getPlayerById(context, playerId);
		memo.set(playerId, player);
		return player;
	} catch (error) {
		context.logger.warn({ err: error, playerId }, "Live V2 player identity unavailable");
		memo.set(playerId, null);
		return null;
	}
};

const getEventByIdMemoized = async (
	context: GraphQLContext,
	eventId: number
): Promise<Event | null> => {
	let memo = eventsMemo.get(context);
	if (!memo) {
		memo = new Map();
		eventsMemo.set(context, memo);
	}
	if (memo.has(eventId)) return memo.get(eventId) ?? null;
	try {
		const event = await eventsService.getEventById(context, eventId);
		memo.set(eventId, event);
		return event;
	} catch (error) {
		context.logger.warn({ err: error, eventId }, "Live V2 event identity unavailable");
		memo.set(eventId, null);
		return null;
	}
};

const preloadPlayersByIds = async (
	context: GraphQLContext,
	ids: readonly number[]
): Promise<void> => {
	const uniqueIds = [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))];
	if (uniqueIds.length === 0) return;
	try {
		const players = await playersService.getPlayersByIds(context, uniqueIds);
		const preload = new Map(context.playersByIdPreload ?? []);
		for (const id of uniqueIds) preload.set(id, null);
		for (const player of players) preload.set(player.id, player);
		context.playersByIdPreload = preload;
	} catch (error) {
		context.logger.warn(
			{ err: error, playerCount: uniqueIds.length },
			"Live V2 player identity preload unavailable"
		);
	}
};

type LiveScoresArgs = {
	eventId?: number | null;
	filter?: LiveScoresFilter | null;
};

type PlayerLiveArgs = {
	playerId: number;
	eventId?: number | null;
};

type EventLiveArgs = { eventId: number };
type LiveSnapshotArgs = { eventId?: number | null };
type LiveExplainArgs = { eventId: number; elementId: number };
type LiveExplainsArgs = { eventId: number; elementIds: number[] };
type TopPerformersArgs = { limit?: number | null };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const numberOrNull = (value: unknown): number | null => {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
};

const integerOrNull = (value: unknown): number | null => {
	const parsed = numberOrNull(value);
	return parsed === null ? null : Math.trunc(parsed);
};

const booleanOrNull = (value: unknown): boolean | null =>
	typeof value === "boolean" ? value : null;

const toLivePerformance = (raw: Record<string, unknown>): LivePerformance => ({
	eventId: integerOrNull(raw.eventId) ?? 0,
	playerId: integerOrNull(raw.elementId) ?? 0,
	minutes: integerOrNull(raw.minutes),
	goalsScored: integerOrNull(raw.goalsScored),
	assists: integerOrNull(raw.assists),
	cleanSheets: integerOrNull(raw.cleanSheets),
	goalsConceded: integerOrNull(raw.goalsConceded),
	ownGoals: integerOrNull(raw.ownGoals),
	penaltiesSaved: integerOrNull(raw.penaltiesSaved),
	penaltiesMissed: integerOrNull(raw.penaltiesMissed),
	yellowCards: integerOrNull(raw.yellowCards),
	redCards: integerOrNull(raw.redCards),
	saves: integerOrNull(raw.saves),
	bonus: integerOrNull(raw.bonus),
	bps: integerOrNull(raw.bps),
	starts: booleanOrNull(raw.starts),
	defensiveContribution: integerOrNull(raw.defensiveContribution),
	expectedGoals: typeof raw.expectedGoals === "string" ? raw.expectedGoals : null,
	expectedAssists: typeof raw.expectedAssists === "string" ? raw.expectedAssists : null,
	expectedGoalInvolvements:
		typeof raw.expectedGoalInvolvements === "string" ? raw.expectedGoalInvolvements : null,
	expectedGoalsConceded:
		typeof raw.expectedGoalsConceded === "string" ? raw.expectedGoalsConceded : null,
	inDreamTeam: booleanOrNull(raw.inDreamTeam),
	totalPoints: integerOrNull(raw.totalPoints) ?? 0,
});

const applyLiveScoresFilter = (
	scores: readonly LivePerformance[],
	filter?: LiveScoresFilter | null
): LivePerformance[] =>
	scores.filter((score) => {
		if (
			filter?.inDreamTeam !== undefined &&
			filter.inDreamTeam !== null &&
			score.inDreamTeam !== filter.inDreamTeam
		)
			return false;
		if (
			filter?.minTotalPoints !== undefined &&
			filter.minTotalPoints !== null &&
			score.totalPoints < filter.minTotalPoints
		)
			return false;
		if (
			filter?.maxTotalPoints !== undefined &&
			filter.maxTotalPoints !== null &&
			score.totalPoints > filter.maxTotalPoints
		)
			return false;
		return true;
	});

const publicationPerformances = (
	publication: Awaited<ReturnType<typeof readLivePublicationV2>>
): LivePerformance[] =>
	publication?.eventLives.map((row) =>
		toLivePerformance(row as unknown as Record<string, unknown>)
	) ?? [];

const toContribution = (
	value: unknown
): {
	identifier: string;
	points: number;
	value: number | null;
	pointsModification: number | null;
} | null => {
	if (!isRecord(value)) return null;
	const points = integerOrNull(value.points);
	if (typeof value.identifier !== "string" || points === null) return null;
	return {
		identifier: value.identifier,
		points,
		value: numberOrNull(value.value),
		pointsModification: integerOrNull(value.pointsModification),
	};
};

const toExplainBreakdown = (
	value: unknown
): {
	fixtureId: number;
	stats: Array<{
		identifier: string;
		points: number;
		value: number | null;
		pointsModification: number | null;
	}>;
}[] => {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		if (!isRecord(entry)) return [];
		const fixtureId = integerOrNull(entry.fixtureId ?? entry.fixture_id);
		if (fixtureId === null) return [];
		let statsValue: unknown = entry.stats;
		if (typeof statsValue === "string") {
			try {
				statsValue = JSON.parse(statsValue) as unknown;
			} catch {
				statsValue = [];
			}
		}
		const stats = Array.isArray(statsValue)
			? statsValue
					.map(toContribution)
					.filter((item): item is NonNullable<typeof item> => item !== null)
			: [];
		return [{ fixtureId, stats }];
	});
};

const explainForRow = async (
	context: GraphQLContext,
	eventId: number,
	elementId: number,
	includeSelectedBy: boolean,
	raw: Record<string, unknown>
): Promise<LiveExplain> => {
	const breakdown = toExplainBreakdown(raw.fixtureBreakdown);
	const core = includeSelectedBy
		? await getCoreLiveIdentitySnapshot(context).catch(() => null)
		: null;
	const selectedBy = includeSelectedBy
		? (core?.players.find((player) => player.id === elementId)?.selectedByPercent ?? null)
		: null;
	const contributions = breakdown.flatMap((entry) => entry.stats);
	return {
		eventId,
		elementId,
		modified: null,
		selectedBy,
		stats: {
			minutes: integerOrNull(raw.minutes),
			goalsScored: integerOrNull(raw.goalsScored),
			assists: integerOrNull(raw.assists),
			cleanSheets: integerOrNull(raw.cleanSheets),
			goalsConceded: integerOrNull(raw.goalsConceded),
			ownGoals: integerOrNull(raw.ownGoals),
			penaltiesSaved: integerOrNull(raw.penaltiesSaved),
			penaltiesMissed: integerOrNull(raw.penaltiesMissed),
			yellowCards: integerOrNull(raw.yellowCards),
			redCards: integerOrNull(raw.redCards),
			saves: integerOrNull(raw.saves),
			bonus: integerOrNull(raw.bonus),
			bps: integerOrNull(raw.bps),
			influence: null,
			creativity: null,
			threat: null,
			ictIndex: null,
			clearancesBlocksInterceptions: null,
			recoveries: null,
			tackles: null,
			defensiveContribution: integerOrNull(raw.defensiveContribution),
			starts:
				raw.starts === null
					? null
					: raw.starts === true
						? 1
						: raw.starts === false
							? 0
							: integerOrNull(raw.starts),
			expectedGoals: numberOrNull(raw.expectedGoals),
			expectedAssists: numberOrNull(raw.expectedAssists),
			expectedGoalInvolvements: numberOrNull(raw.expectedGoalInvolvements),
			expectedGoalsConceded: numberOrNull(raw.expectedGoalsConceded),
			totalPoints: integerOrNull(raw.totalPoints),
			inDreamTeam: booleanOrNull(raw.inDreamTeam),
		},
		breakdown,
		contributions,
	};
};

const findExplain = async (
	context: GraphQLContext,
	eventId: number,
	elementId: number,
	includeSelectedBy: boolean
): Promise<LiveExplain | null> => {
	const publication = await readLivePublicationV2(context, eventId).catch((error) => {
		context.logger.warn({ err: error, eventId }, "Live V2 explain publication unavailable");
		return null;
	});
	const raw = publication?.eventLives.find((row) => Number(row.elementId) === elementId);
	return raw
		? explainForRow(
				context,
				eventId,
				elementId,
				includeSelectedBy,
				raw as unknown as Record<string, unknown>
			)
		: null;
};

export const assertValidLiveExplainBatch = (elementIds: readonly number[]): void => {
	if (elementIds.length > 15) {
		throw new GraphQLError("Live explain batch exceeds the 15 player limit", {
			extensions: { code: "QUERY_TOO_COMPLEX" },
		});
	}
	if (
		elementIds.some((elementId) => !Number.isSafeInteger(elementId) || elementId <= 0) ||
		new Set(elementIds).size !== elementIds.length
	) {
		throw new GraphQLError("Live explain player IDs must be unique positive integers", {
			extensions: { code: "BAD_USER_INPUT" },
		});
	}
};

export const normalizeTopPerformersLimit = (limit?: number | null): number =>
	Math.max(0, Math.min(50, limit ?? 10));

export const liveResolvers = {
	Query: {
		liveScores: async (
			_parent: unknown,
			args: LiveScoresArgs,
			context: GraphQLContext,
			info: GraphQLResolveInfo
		): Promise<LivePerformance[]> => {
			const eventId = args.eventId ?? (await getCurrentEventId(context));
			if (!eventId) return [];
			const publication = await readLivePublicationV2(context, eventId).catch((error) => {
				context.logger.warn({ err: error, eventId }, "Live V2 score publication unavailable");
				return null;
			});
			const scores = applyLiveScoresFilter(publicationPerformances(publication), args.filter);
			if (scores.length > 0 && parentSelectionRequestsField(info, "player")) {
				await preloadPlayersByIds(
					context,
					scores.map((score) => score.playerId)
				);
			}
			return scores;
		},

		playerLive: async (
			_parent: unknown,
			args: PlayerLiveArgs,
			context: GraphQLContext
		): Promise<LivePerformance | null> => {
			const eventId = args.eventId ?? (await getCurrentEventId(context));
			if (!eventId) return null;
			const publication = await readLivePublicationV2(context, eventId).catch(() => null);
			return (
				publicationPerformances(publication).find((item) => item.playerId === args.playerId) ?? null
			);
		},

		eventLive: async (
			_parent: unknown,
			args: EventLiveArgs,
			context: GraphQLContext,
			info: GraphQLResolveInfo
		): Promise<EventLive> =>
			measureRequestStage(context.requestTiming, "gwSummary.eventLive", async () => {
				const publication = await readLivePublicationV2(context, args.eventId).catch(() => null);
				const performances = publicationPerformances(publication);
				if (parentSelectionRequestsField(info, "player")) {
					await preloadPlayersByIds(
						context,
						performances.map((item) => item.playerId)
					);
				}
				return { eventId: args.eventId, performances };
			}),

		eventLiveExplain: async (
			_parent: unknown,
			args: LiveExplainArgs,
			context: GraphQLContext,
			info: GraphQLResolveInfo
		): Promise<LiveExplain | null> =>
			findExplain(
				context,
				args.eventId,
				args.elementId,
				directSelectionRequestsField(info, "selectedBy")
			),

		eventLiveExplains: async (
			_parent: unknown,
			args: LiveExplainsArgs,
			context: GraphQLContext,
			info: GraphQLResolveInfo
		): Promise<LiveExplain[]> => {
			assertValidLiveExplainBatch(args.elementIds);
			const includeSelectedBy = directSelectionRequestsField(info, "selectedBy");
			const explains = (
				await Promise.all(
					args.elementIds.map((elementId) =>
						findExplain(context, args.eventId, elementId, includeSelectedBy)
					)
				)
			).filter((value): value is LiveExplain => value !== null);
			if (explains.length > 0 && parentSelectionRequestsField(info, "player")) {
				await preloadPlayersByIds(
					context,
					explains.map((item) => item.elementId)
				);
			}
			return explains;
		},

		liveSnapshot: async (
			_parent: unknown,
			args: LiveSnapshotArgs,
			context: GraphQLContext
		): Promise<LiveSnapshotMetaV2 | null> => {
			const eventId = args.eventId ?? (await getCurrentEventId(context));
			return eventId ? loadLiveSnapshotMetaV2(context, eventId) : null;
		},
	},

	EventLive: {
		event: (parent: EventLive, _args: Record<string, never>, context: GraphQLContext) =>
			getEventByIdMemoized(context, parent.eventId),
		performances: (parent: EventLive): LivePerformance[] => parent.performances,
		dreamTeam: (parent: EventLive): LivePerformance[] =>
			parent.performances.filter((item) => item.inDreamTeam === true),
		topPerformers: (parent: EventLive, args: TopPerformersArgs): LivePerformance[] =>
			[...parent.performances]
				.sort((left, right) => right.totalPoints - left.totalPoints)
				.slice(0, normalizeTopPerformersLimit(args.limit)),
	},

	LivePerformance: {
		event: (parent: LivePerformance, _args: Record<string, never>, context: GraphQLContext) =>
			getEventByIdMemoized(context, parent.eventId),
		player: (parent: LivePerformance, _args: Record<string, never>, context: GraphQLContext) =>
			getPlayerByIdMemoized(context, parent.playerId),
		expectedGoals: (parent: LivePerformance): number | null => numberOrNull(parent.expectedGoals),
		expectedAssists: (parent: LivePerformance): number | null =>
			numberOrNull(parent.expectedAssists),
		expectedGoalInvolvements: (parent: LivePerformance): number | null =>
			numberOrNull(parent.expectedGoalInvolvements),
		expectedGoalsConceded: (parent: LivePerformance): number | null =>
			numberOrNull(parent.expectedGoalsConceded),
	},

	LiveExplain: {
		contributions: (parent: LiveExplain): NonNullable<LiveExplain["contributions"]> =>
			parent.contributions && parent.contributions.length > 0
				? parent.contributions
				: parent.breakdown.flatMap((entry) => entry.stats),
		event: (parent: LiveExplain, _args: Record<string, never>, context: GraphQLContext) =>
			getEventByIdMemoized(context, parent.eventId),
		player: (parent: LiveExplain, _args: Record<string, never>, context: GraphQLContext) =>
			getPlayerByIdMemoized(context, parent.elementId),
		selectedBy: (parent: LiveExplain): number | null => parent.selectedBy,
	},
};
