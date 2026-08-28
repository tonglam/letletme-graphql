import { GraphQLError } from "graphql";
import type { GraphQLContext } from "../../graphql/context";
import type {
	PriceChangeBoard,
	PriceChangeObservedEvent,
} from "../../infra/price-change-predictions-client";
import {
	readPriceChangeLiveBoard,
	readPriceChangeLiveCursor,
	type PriceChangeLiveBoard,
	type PriceChangeLiveCursor,
} from "../../infra/price-change-live-client";
import { priceChangesService } from "./service";
import { buildDataCompleteness } from "../../graphql/data-completeness";

function assertCurrentSeason(
	requestedSeasonCode: string | null | undefined,
	context: GraphQLContext
): void {
	if (
		requestedSeasonCode !== null &&
		requestedSeasonCode !== undefined &&
		requestedSeasonCode !== context.currentSeason.seasonCode
	) {
		throw new GraphQLError("Price-change live data is only available for the current season", {
			extensions: { code: "BAD_USER_INPUT" },
		});
	}
}

function marketPriceChangeForObservedEvent(
	board: PriceChangeBoard,
	event: PriceChangeObservedEvent,
	playerId: number,
	oldPrice: number,
	newPrice: number
) {
	const player = board.players.find((candidate) => candidate.playerId === playerId);
	if (!player) return null;
	const position = {
		GKP: "GOALKEEPER",
		DEF: "DEFENDER",
		MID: "MIDFIELDER",
		FWD: "FORWARD",
	} as const;
	return {
		player: {
			playerId: player.playerId,
			playerCode: player.playerCode,
			webName: player.webName,
			teamId: player.teamId,
			teamName: player.teamName,
			teamShortName: player.teamShortName,
			position: position[player.position],
			price: newPrice,
			selectedByPercent: player.selectedByPercent,
		},
		changeDate: event.changeDate,
		oldPrice,
		newPrice,
		change: newPrice - oldPrice,
		direction: newPrice > oldPrice ? "RISE" : "FALL",
	};
}

export const priceChangesResolvers = {
	Query: {
		priceChangeBoard: async (
			_parent: unknown,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<PriceChangeBoard> => priceChangesService.getBoard(context),
		priceChangeLiveCursor: async (
			_parent: unknown,
			args: { seasonCode?: string | null },
			context: GraphQLContext
		): Promise<PriceChangeLiveCursor> => {
			assertCurrentSeason(args.seasonCode, context);
			return readPriceChangeLiveCursor(context);
		},
		priceChangeLiveBoard: async (
			_parent: unknown,
			args: { seasonCode?: string | null; revision?: string | null; sourceHash?: string | null },
			context: GraphQLContext
		): Promise<PriceChangeLiveBoard> => {
			assertCurrentSeason(args.seasonCode, context);
			return readPriceChangeLiveBoard(context, args.revision, args.sourceHash);
		},
	},
	PriceChangeBoard: {
		latestEvent: (parent: PriceChangeBoard) => {
			const event = parent.latestEvent;
			if (!event) return null;
			const changes = event.changes.map((change) =>
				marketPriceChangeForObservedEvent(
					parent,
					event,
					change.playerId,
					change.oldPrice,
					change.newPrice
				)
			);
			return changes.some((change) => change === null) ? null : { ...event, changes };
		},
		completeness: (parent: PriceChangeBoard, _args: unknown, context: GraphQLContext) =>
			buildDataCompleteness({
				contractKey: "market-price",
				scopeKey: `season:${context.currentSeason.seasonCode}:price-change-board`,
				revision: parent.revision,
				sourceCheckedAt: parent.fetchedAt,
				expectedCount: parent.expectedPlayerCount,
				observedCount: parent.observedPlayerCount,
				eligibility: parent.status === "UNAVAILABLE" ? "INVALID" : undefined,
				complete: parent.status === "READY",
			}),
	},
};
