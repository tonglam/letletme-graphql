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
import { homeMarketRepository, type HomeMarketDesk } from "./market-repository";
import type { EntryOfficialH2HDeskItem } from "../tournaments/repository";
import { tournamentsService } from "../tournaments/service";
import { viewerEntryIdForPrincipal } from "../../graphql/authorization";
import type { Event } from "../events/repository";
import { entryLiveBatchService, type BatchLiveCalcResult } from "../entry-live/batch-service";
import type { LiveCalcData } from "../entry-live/calc-service";
import { isTraceableOfficialManagerScore } from "../entry-live/manager-score";

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
			if (!official) return league;
			if (
				!official.isFinal ||
				!official.standingsPublished ||
				!official.standingsCurrentEventComplete ||
				official.rank === null
			) {
				return { ...league, rankState: "UPDATING" };
			}
			return {
				...league,
				rank: official.rank,
				rankState: "READY",
				rankCheckedAt: official.scoreCheckedAt ?? league.rankCheckedAt,
				movement: movementFromRanks(official.rank, official.lastRank),
			};
		}),
	};
};

const isFinalEvent = (event: Event): boolean => event.finished && event.dataChecked;

const checkedAtOrAfter = (
	checkedAt: string | null,
	boundary: string | null | undefined
): boolean => {
	const checkedTimestamp = Date.parse(checkedAt ?? "");
	const boundaryTimestamp = Date.parse(boundary ?? "");
	return (
		Number.isFinite(checkedTimestamp) &&
		Number.isFinite(boundaryTimestamp) &&
		checkedTimestamp >= boundaryTimestamp
	);
};

export const applyHomeRankLifecycle = (
	desk: HomePersonalDesk,
	event: Event | null
): HomePersonalDesk => {
	if (!event) return desk;
	const final = isFinalEvent(event);
	const leagueRanks = desk.leagueRanks.map((league) => ({
		...league,
		rankState: !final
			? ("UPDATING" as const)
			: league.rank !== null && checkedAtOrAfter(league.rankCheckedAt, event.dataCheckedAt)
				? ("READY" as const)
				: ("UPDATING" as const),
	}));
	return {
		...desk,
		rankState: !final
			? "UPDATING"
			: desk.overallRank !== null && checkedAtOrAfter(desk.rankCheckedAt, event.dataCheckedAt)
				? "READY"
				: "UPDATING",
		leagueRanks,
	};
};

const pointsStateFromCalc = (calc: LiveCalcData): HomePersonalDesk["pointsState"] => {
	switch (calc.score.state) {
		case "FRESH":
			return "LIVE";
		case "STALE":
			return "STALE";
		case "SETTLING":
			return "SETTLING";
		case "FINAL":
			return "FINAL";
		default:
			return "UNAVAILABLE";
	}
};

const scoreCanHeadline = (calc: LiveCalcData | undefined): boolean =>
	calc !== undefined &&
	isTraceableOfficialManagerScore(calc.score) &&
	typeof calc.score.totalPoints === "number" &&
	calc.score.totalScope === "OVERALL";

export const applyHomeScoreLifecycle = (
	desk: HomePersonalDesk,
	event: Event | null,
	calc: LiveCalcData | undefined
): HomePersonalDesk => {
	if (!event) return desk;
	const final = isFinalEvent(event);
	if (!calc || !scoreCanHeadline(calc)) {
		if (final) {
			// Once the event is settled, the live calculator is no longer the
			// source of truth. Keep the official snapshot that the home query
			// already loaded instead of clearing it or marking the rank live.
			const hasOfficialPoints = typeof desk.overallPoints === "number";
			return {
				...desk,
				pointsState: hasOfficialPoints ? "FINAL" : "SETTLING",
				pointsCheckedAt: hasOfficialPoints
					? (desk.pointsCheckedAt ?? desk.sourceCheckedAt)
					: desk.pointsCheckedAt,
			};
		}
		return {
			...desk,
			overallPoints: null,
			pointsState: final ? "SETTLING" : "UNAVAILABLE",
			pointsCheckedAt: calc?.score.checkedAt ?? null,
			rankState: "UPDATING",
		};
	}
	const finalRank = final ? calc.score.overallRank : null;
	return {
		...desk,
		overallPoints: calc.score.totalPoints,
		pointsState: pointsStateFromCalc(calc),
		pointsCheckedAt: calc.score.checkedAt,
		overallRank: finalRank ?? desk.overallRank,
		rankState: finalRank === null ? "UPDATING" : "READY",
		rankCheckedAt: finalRank === null ? desk.rankCheckedAt : calc.score.checkedAt,
	};
};

const pairScore = (calc: LiveCalcData | undefined): number | null =>
	calc &&
	isTraceableOfficialManagerScore(calc.score) &&
	typeof calc.score.netEventPoints === "number"
		? calc.score.netEventPoints
		: null;

const oldestCheckedAt = (...values: Array<string | null | undefined>): string | null => {
	const parsed = values
		.flatMap((value) => {
			const timestamp = Date.parse(value ?? "");
			return Number.isFinite(timestamp) && value ? [{ value, timestamp }] : [];
		})
		.sort((left, right) => left.timestamp - right.timestamp);
	return parsed[0]?.value ?? null;
};

export const applyHomePairScores = (
	desk: HomePersonalDesk,
	event: Event | null,
	results: BatchLiveCalcResult["results"]
): HomePersonalDesk => {
	if (!event || isFinalEvent(event)) return desk;
	return {
		...desk,
		leagueRanks: desk.leagueRanks.map((league) => {
			const matchup = league.h2hMatchup;
			if (!matchup?.isLive || matchup.eventId !== event.id) return league;
			const viewerCalc = matchup.viewer.entryId ? results.get(matchup.viewer.entryId) : undefined;
			const opponentCalc = matchup.opponent.entryId
				? results.get(matchup.opponent.entryId)
				: undefined;
			return {
				...league,
				h2hMatchup: {
					...matchup,
					viewer: { ...matchup.viewer, points: pairScore(viewerCalc) },
					opponent: matchup.opponent.entryId
						? { ...matchup.opponent, points: pairScore(opponentCalc) }
						: matchup.opponent,
					sourceCheckedAt: oldestCheckedAt(
						viewerCalc?.score.checkedAt,
						opponentCalc?.score.checkedAt
					),
				},
			};
		}),
	};
};

const authError = (
	message: string,
	code: "UNAUTHENTICATED" | "VIEWER_ENTRY_REQUIRED" | "FORBIDDEN",
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

	getMarketDesk(context: GraphQLContext): Promise<HomeMarketDesk> {
		return homeMarketRepository.getDesk(context);
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
		const entryId = viewerEntryIdForPrincipal(context.principal);
		if (!entryId) {
			throw authError("A viewed FPL team is required", "VIEWER_ENTRY_REQUIRED", 403);
		}
		const [rawDesk, eventContext] = await Promise.all([
			homeRepository.getPersonalDesk(context, entryId),
			eventsService.getCoreEventContext(context).catch((error) => {
				context.logger.warn(
					{
						err: error,
						requestId: context.requestId,
						operationName: context.operationName,
						entryId,
					},
					"Home event lifecycle unavailable; keeping the last official desk snapshot"
				);
				return null;
			}),
		]);
		const eventId = eventContext
			? (eventContext.currentEventId ?? eventContext.latestFinishedEventId)
			: null;
		const event = eventId ? await eventsService.getEventById(context, eventId) : null;
		let desk = applyHomeRankLifecycle(rawDesk, event);

		let batch: BatchLiveCalcResult | null = null;
		if (event && !isFinalEvent(event)) {
			const pairEntryIds = desk.leagueRanks.flatMap((league) => {
				const matchup = league.h2hMatchup;
				if (!matchup?.isLive || matchup.eventId !== event.id) return [];
				return [matchup.viewer.entryId, matchup.opponent.entryId].filter(
					(candidate): candidate is number =>
						candidate !== null && Number.isSafeInteger(candidate) && candidate > 0
				);
			});
			const entryIds = [...new Set([entryId, ...pairEntryIds])];
			try {
				batch = await entryLiveBatchService.calcLivePointsForEntries(context, event.id, entryIds, {
					managerReadMode: "CACHE_ONLY",
				});
			} catch (error) {
				context.logger.warn(
					{
						err: error,
						requestId: context.requestId,
						operationName: context.operationName,
						entryId,
						eventId: event.id,
					},
					"Home live score projection unavailable"
				);
			}
		}
		desk = applyHomeScoreLifecycle(desk, event, batch?.results.get(entryId));
		if (batch) desk = applyHomePairScores(desk, event, batch.results);

		const hasOfficialH2H = desk.leagueRanks.some(
			(league) => league.leagueType === "H2H" && league.tournamentId !== null
		);
		if (!event || !isFinalEvent(event) || !hasOfficialH2H) return desk;
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
