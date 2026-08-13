import type { GraphQLContext } from "../../graphql/context";
import type { CoreEventContext } from "../events/repository";
import { eventsService } from "../events/service";
import type { PlayersForPickerPayload, Team } from "../players/repository";
import { playersService } from "../players/service";
import type { PlayerDetail } from "../player-detail/repository";
import { playerDetailService } from "../player-detail/service";
import { playerStateService } from "../player-state/service";
import type { PlayerStateProfile } from "../player-state/types";
import { GraphQLError } from "graphql";

type PlayerStatsBootstrap = {
	context: CoreEventContext;
	teams: Team[];
	directory: PlayersForPickerPayload;
};

type PlayerStatsDeskEntry = {
	playerId: number;
	eventId: number;
	horizon: number;
	batch: PlayerStatsDeskBatch;
};

type PlayerStatsDeskBatch = {
	playerIds: number[];
	eventId: number;
	horizon: number;
};

const detailBatchMemo = new WeakMap<
	PlayerStatsDeskBatch,
	ReturnType<typeof playerDetailService.getPlayerDetails>
>();
const stateBatchMemo = new WeakMap<
	PlayerStatsDeskBatch,
	ReturnType<typeof playerStateService.getPlayerStateProfiles>
>();

const memoizedDetail = (
	context: GraphQLContext,
	parent: PlayerStatsDeskEntry
): Promise<PlayerDetail | null> => {
	let batch = detailBatchMemo.get(parent.batch);
	if (!batch) {
		batch = playerDetailService.getPlayerDetails(
			context,
			parent.batch.playerIds,
			parent.batch.eventId
		);
		detailBatchMemo.set(parent.batch, batch);
	}
	return batch.then((details) => details.get(parent.playerId) ?? null);
};

const memoizedState = (
	context: GraphQLContext,
	parent: PlayerStatsDeskEntry
): Promise<PlayerStateProfile | null> => {
	let batch = stateBatchMemo.get(parent.batch);
	if (!batch) {
		batch = playerStateService.getPlayerStateProfiles(
			context,
			parent.batch.playerIds,
			parent.batch.horizon
		);
		stateBatchMemo.set(parent.batch, batch);
	}
	return batch.then((profiles) => profiles.get(parent.playerId) ?? null);
};

const nullableDeskField = async <T>(
	context: GraphQLContext,
	field: "overview" | "state" | "evidence",
	playerId: number,
	load: () => Promise<T>
): Promise<T | null> => {
	try {
		return await load();
	} catch (error) {
		context.logger.warn({ err: error, field, playerId }, "Player stats desk field is unavailable");
		return null;
	}
};

export const playerStatsResolvers = {
	Query: {
		playerStatsBootstrap: async (
			_parent: unknown,
			args: { limit?: number | null },
			context: GraphQLContext
		): Promise<PlayerStatsBootstrap> => {
			// Resolve the immutable publication first. The following SQL directory
			// and team projection then share this request's pinned revision.
			const eventContext = await eventsService.getCoreEventContext(context);
			context.dataRevision ??= `core-${eventContext.revision}`;
			const [teams, directory] = await Promise.all([
				playersService.listTeams(context),
				playersService.getPlayersForPicker(
					context,
					args.limit ?? 20,
					null,
					null,
					undefined,
					"AUTO",
					null
				),
			]);
			return { context: eventContext, teams, directory };
		},
		playerStatsDesk: async (
			_parent: unknown,
			args: { playerIds: number[]; eventId: number; horizon?: number | null },
			context: GraphQLContext
		): Promise<{ eventId: number; horizon: number; entries: PlayerStatsDeskEntry[] }> => {
			const uniquePlayerIds = [...new Set(args.playerIds)];
			if (
				args.playerIds.length < 1 ||
				args.playerIds.length > 2 ||
				uniquePlayerIds.length !== args.playerIds.length ||
				uniquePlayerIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
				!Number.isSafeInteger(args.eventId) ||
				args.eventId < 1 ||
				args.eventId > 38
			) {
				throw new GraphQLError("Player stats desk requires 1-2 unique players and a valid event", {
					extensions: { code: "BAD_USER_INPUT" },
				});
			}
			const horizon = args.horizon ?? 5;
			if (!Number.isSafeInteger(horizon) || horizon < 1 || horizon > 8) {
				throw new GraphQLError("Player stats horizon must be between 1 and 8", {
					extensions: { code: "BAD_USER_INPUT" },
				});
			}
			const eventContext = await eventsService.getCoreEventContext(context);
			context.dataRevision ??= `core-${eventContext.revision}`;
			const batch = { playerIds: uniquePlayerIds, eventId: args.eventId, horizon };
			return {
				eventId: args.eventId,
				horizon,
				entries: uniquePlayerIds.map((playerId) => ({
					playerId,
					eventId: args.eventId,
					horizon,
					batch,
				})),
			};
		},
	},
	PlayerStatsDeskEntry: {
		overview: (
			parent: PlayerStatsDeskEntry,
			_args: unknown,
			context: GraphQLContext
		): Promise<PlayerDetail | null> =>
			nullableDeskField(context, "overview", parent.playerId, () =>
				memoizedDetail(context, parent)
			),
		state: (
			parent: PlayerStatsDeskEntry,
			_args: unknown,
			context: GraphQLContext
		): Promise<PlayerStateProfile | null> =>
			nullableDeskField(context, "state", parent.playerId, () => memoizedState(context, parent)),
		evidence: (
			parent: PlayerStatsDeskEntry,
			_args: unknown,
			context: GraphQLContext
		): Promise<PlayerDetail | null> =>
			nullableDeskField(context, "evidence", parent.playerId, () =>
				memoizedDetail(context, parent)
			),
	},
};
