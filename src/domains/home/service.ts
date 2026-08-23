import { GraphQLError } from "graphql";
import type { GraphQLContext } from "../../graphql/context";
import type { CoreEventContext } from "../events/repository";
import { eventsService } from "../events/service";
import type { Fixture } from "../fixtures/repository";
import { fixturesService } from "../fixtures/service";
import type { GameweekDesk } from "../gameweek/service";
import { gameweekService } from "../gameweek/service";
import { homeRepository, movementFromRanks, type HomePersonalDesk } from "./repository";
import { marketService } from "../market/service";
import type { MarketAvailabilityUpdate, MarketPulse } from "../market/repository";
import type { Player, TopTransfersEnriched } from "../players/repository";
import { playersService } from "../players/service";
import { measureRequestStage } from "../../http/request-timing";
import type { EntryOfficialH2HDeskItem } from "../tournaments/repository";
import { tournamentsService } from "../tournaments/service";

export type HomePublicBootstrap = {
	context: CoreEventContext;
	fixtures: Fixture[];
};

export type HomeMarketPulse = Pick<
	MarketPulse,
	"coverage" | "mostSelected" | "availabilityUpdates" | "priceChanges"
>;

export type HomeTransferSignal = {
	player: Player;
	eventId: number;
	transfersInEvent: number;
	transfersOutEvent: number;
};

export type HomeTransferSectionState = "AVAILABLE" | "UNAVAILABLE";

export type HomeGameweek = {
	gameweekDesk: GameweekDesk;
	topTransfersIn: HomeTransferSignal[];
	topTransfersOut: HomeTransferSignal[];
	transfersState: HomeTransferSectionState;
};

const HOME_MARKET_LIMIT = 5;
const HOME_MARKET_MIN_OWNERSHIP = 1;
const HOME_TRANSFER_LIMIT = 5;

const compactTransferSignals = (
	result: PromiseSettledResult<TopTransfersEnriched>
): { rows: HomeTransferSignal[]; complete: boolean } => {
	if (result.status === "rejected") return { rows: [], complete: false };
	let complete = true;
	const rows = result.value.stats.flatMap((row) => {
		const player = result.value.players[row.playerId];
		if (!player) {
			complete = false;
			return [];
		}
		return [{ ...row, player }];
	});
	return { rows, complete };
};

export const settleHomeTransfers = (
	transfersInResult: PromiseSettledResult<TopTransfersEnriched>,
	transfersOutResult: PromiseSettledResult<TopTransfersEnriched>
): Pick<HomeGameweek, "topTransfersIn" | "topTransfersOut" | "transfersState"> => {
	const transfersIn = compactTransferSignals(transfersInResult);
	const transfersOut = compactTransferSignals(transfersOutResult);
	return {
		topTransfersIn: transfersIn.rows,
		topTransfersOut: transfersOut.rows,
		transfersState: transfersIn.complete && transfersOut.complete ? "AVAILABLE" : "UNAVAILABLE",
	};
};

const selectHomeAvailability = (
	updates: readonly MarketAvailabilityUpdate[]
): MarketAvailabilityUpdate[] => {
	const preferred = updates.filter(
		(update) => update.player.selectedByPercent >= HOME_MARKET_MIN_OWNERSHIP
	);
	if (preferred.length >= HOME_MARKET_LIMIT) {
		return preferred.slice(0, HOME_MARKET_LIMIT);
	}
	const preferredSet = new Set(preferred);
	return [...preferred, ...updates.filter((update) => !preferredSet.has(update))].slice(
		0,
		HOME_MARKET_LIMIT
	);
};

export const compactHomeMarketPulse = (pulse: MarketPulse): HomeMarketPulse => ({
	coverage: pulse.coverage,
	mostSelected: pulse.mostSelected.slice(0, HOME_MARKET_LIMIT),
	availabilityUpdates: selectHomeAvailability(pulse.availabilityUpdates),
	priceChanges: pulse.priceChanges.slice(0, HOME_MARKET_LIMIT),
});

export const reconcileHomeOfficialH2HRanks = (
	desk: HomePersonalDesk,
	officialH2HDesk: readonly EntryOfficialH2HDeskItem[]
): HomePersonalDesk => {
	const officialByTournament = new Map(
		officialH2HDesk.map((row) => [row.tournamentId, row] as const)
	);
	return {
		...desk,
		leagueRanks: desk.leagueRanks.map((league) => {
			if (league.leagueType !== "H2H" || league.tournamentId === null) return league;
			const official = officialByTournament.get(league.tournamentId);
			if (!official?.standingsPublished || official.rank === null) return league;
			return {
				...league,
				rank: official.rank,
				movement: official.standingsCurrentEventComplete
					? movementFromRanks(official.rank, official.lastRank)
					: league.movement,
			};
		}),
	};
};

const authError = (
	message: string,
	code: "UNAUTHENTICATED" | "FORBIDDEN",
	status: 401 | 403
): GraphQLError => new GraphQLError(message, { extensions: { code, http: { status } } });

export const homeService = {
	async getGameweek(context: GraphQLContext, eventId: number): Promise<HomeGameweek> {
		const startedAt = performance.now();
		const gameweekDeskPromise = measureRequestStage(
			context.requestTiming,
			"home.gameweekDesk",
			() => gameweekService.getGameweekDesk(context, eventId)
		);
		const transferResultsPromise = Promise.allSettled([
			measureRequestStage(context.requestTiming, "home.topTransfersIn", () =>
				playersService.getTopTransfersInEnriched(context, eventId, HOME_TRANSFER_LIMIT)
			),
			measureRequestStage(context.requestTiming, "home.topTransfersOut", () =>
				playersService.getTopTransfersOutEnriched(context, eventId, HOME_TRANSFER_LIMIT)
			),
		]);

		// The desk is the primary Home section. Transfer failures are isolated below,
		// while a desk failure retains the existing GraphQL error contract.
		const gameweekDesk = await gameweekDeskPromise;
		const [transfersInResult, transfersOutResult] = await transferResultsPromise;
		const transfers = settleHomeTransfers(transfersInResult, transfersOutResult);
		context.logger.info(
			{
				requestId: context.requestId,
				operationName: context.operationName,
				transfersState: transfers.transfersState,
				transfersInRows: transfers.topTransfersIn.length,
				transfersOutRows: transfers.topTransfersOut.length,
				totalDurationMs: Number((performance.now() - startedAt).toFixed(2)),
			},
			"Home gameweek loaded"
		);
		return { gameweekDesk, ...transfers };
	},

	async getMarketPulse(context: GraphQLContext, days: number): Promise<HomeMarketPulse> {
		const startedAt = performance.now();
		const pulse = await marketService.getMarketPulse(context, days);
		const compact = compactHomeMarketPulse(pulse);
		context.logger.info(
			{
				requestId: context.requestId,
				operationName: context.operationName,
				mostSelectedRows: compact.mostSelected.length,
				availabilityRows: compact.availabilityUpdates.length,
				priceRows: compact.priceChanges.length,
				totalDurationMs: Number((performance.now() - startedAt).toFixed(2)),
			},
			"Home market pulse loaded"
		);
		return compact;
	},

	async getPublicBootstrap(context: GraphQLContext): Promise<HomePublicBootstrap> {
		const startedAt = performance.now();
		const eventContextStartedAt = performance.now();
		const eventContext = await eventsService.getCoreEventContext(context);
		const eventContextDurationMs = performance.now() - eventContextStartedAt;
		const fixturesStartedAt = performance.now();
		const fixtures = eventContext.nextEventId
			? await fixturesService.getEventFixtures(context, eventContext.nextEventId)
			: [];
		const fixturesDurationMs = performance.now() - fixturesStartedAt;
		context.logger.info(
			{
				requestId: context.requestId,
				operationName: context.operationName,
				coreRevision: eventContext.revision,
				eventContextDurationMs: Number(eventContextDurationMs.toFixed(2)),
				fixturesDurationMs: Number(fixturesDurationMs.toFixed(2)),
				fixtureCount: fixtures.length,
				totalDurationMs: Number((performance.now() - startedAt).toFixed(2)),
			},
			"Home public bootstrap loaded"
		);
		return { context: eventContext, fixtures };
	},

	async getPersonalDesk(context: GraphQLContext): Promise<HomePersonalDesk> {
		if (!context.principal) {
			throw authError("Authentication required", "UNAUTHENTICATED", 401);
		}
		if (!context.principal.fplEntryId || !context.principal.fplEntryVerifiedAt) {
			throw authError("A verified FPL binding is required", "FORBIDDEN", 403);
		}
		const entryId = context.principal.fplEntryId;
		const desk = await homeRepository.getPersonalDesk(context, entryId);
		if (
			!desk.leagueRanks.some(
				(league) => league.leagueType === "H2H" && league.tournamentId !== null
			)
		) {
			return desk;
		}
		try {
			const officialH2HDesk = await tournamentsService.getEntryOfficialH2HDesk(context, entryId);
			return reconcileHomeOfficialH2HRanks(desk, officialH2HDesk);
		} catch (error) {
			context.logger.warn(
				{ err: error, requestId: context.requestId, operationName: context.operationName, entryId },
				"Home official H2H rank reconciliation unavailable"
			);
			return desk;
		}
	},
};
