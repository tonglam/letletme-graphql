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
import { viewerEntryIdForPrincipal } from "../../graphql/authorization";
import type { Event } from "../events/repository";
import {
	calcLivePointsForEntriesV2,
	readLivePublicationByRefV2,
	type BatchLiveCalcResultV2,
	type LiveCalcDataV2,
} from "../entry-live/v2-service";
import {
	readH2HLeaguePublicationV2,
	type H2HLeaguePublicationReadV2,
	type H2HStandingsPayloadV2,
} from "../live-desks/h2h-v2";

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

const validOfficialH2HRank = (
	payload: H2HStandingsPayloadV2 | undefined,
	eventId: number,
	rank: number | null | undefined
): boolean =>
	payload?.state === "READY" &&
	payload.throughEventId === eventId &&
	typeof rank === "number" &&
	Number.isSafeInteger(rank) &&
	rank > 0;

type HomeOfficialH2HStandingRead = {
	payload: H2HStandingsPayloadV2;
	globalRef: H2HLeaguePublicationReadV2["publication"]["globalRef"];
	globalFinalized: boolean;
};

type HomeOfficialH2HStandingInput = H2HStandingsPayloadV2 | HomeOfficialH2HStandingRead;

const standingPayload = (
	value: HomeOfficialH2HStandingInput | null | undefined
): H2HStandingsPayloadV2 | undefined =>
	value && "payload" in value ? value.payload : (value ?? undefined);

const standingHasFinalGlobal = (value: HomeOfficialH2HStandingInput | null | undefined): boolean =>
	value && "payload" in value ? value.globalFinalized : true;

export const applyHomeOfficialH2HRanksV2 = (
	desk: HomePersonalDesk,
	eventId: number,
	standingsByTournament: ReadonlyMap<number, HomeOfficialH2HStandingInput | null>
): HomePersonalDesk => ({
	...desk,
	leagueRanks: desk.leagueRanks.map((league) => {
		if (league.leagueType !== "H2H" || league.tournamentId === null) return league;
		const raw = standingsByTournament.get(league.tournamentId) ?? undefined;
		const payload = standingPayload(raw);
		const standing = payload?.rows.find((row) => row.entryId === desk.entryId);
		const rank = standing?.rank;
		if (
			!standingHasFinalGlobal(raw) ||
			!validOfficialH2HRank(payload, eventId, rank) ||
			typeof rank !== "number"
		) {
			return { ...league, rankState: "UPDATING" };
		}
		return {
			...league,
			rank,
			rankState: "READY" as const,
			rankCheckedAt: payload?.sourceCheckedAt ?? league.rankCheckedAt,
			// V2 standings deliberately carries the current official rank only.
			// Use the persisted rank as the comparison point when it changed, and
			// retain the persisted movement when it did not.
			movement: rank === league.rank ? league.movement : movementFromRanks(rank, league.rank),
		};
	}),
});

const reconcileHomeOfficialH2HRanksV2 = async (
	context: GraphQLContext,
	desk: HomePersonalDesk,
	eventId: number
): Promise<HomePersonalDesk> => {
	const tournamentIds = [
		...new Set(
			desk.leagueRanks.flatMap((league) =>
				league.leagueType === "H2H" && league.tournamentId !== null ? [league.tournamentId] : []
			)
		),
	];
	if (tournamentIds.length === 0) return desk;
	const reads = await Promise.all(
		tournamentIds.map(async (tournamentId) => {
			try {
				const read = await readH2HLeaguePublicationV2(
					context,
					tournamentId,
					eventId,
					"H2H_STANDINGS"
				);
				const payload = read?.payload.standings as H2HStandingsPayloadV2 | undefined;
				if (!read || !payload) return [tournamentId, null] as const;
				const global = await readLivePublicationByRefV2(
					context,
					eventId,
					read.publication.globalRef
				).catch(() => null);
				if (
					!global ||
					global.publication.state !== "FINALIZED" ||
					global.publication.publicationId !== read.publication.globalRef.publicationId ||
					global.publication.generation !== read.publication.globalRef.generation
				)
					return [tournamentId, null] as const;
				return [
					tournamentId,
					{
						payload,
						globalRef: read.publication.globalRef,
						globalFinalized: true,
					},
				] as const;
			} catch (error) {
				context.logger.warn(
					{
						err: error,
						requestId: context.requestId,
						operationName: context.operationName,
						eventId,
						tournamentId,
					},
					"Home official H2H standings unavailable"
				);
				return [tournamentId, null] as const;
			}
		})
	);
	return applyHomeOfficialH2HRanksV2(desk, eventId, new Map(reads));
};

const pointsStateFromCalc = (calc: LiveCalcDataV2): HomePersonalDesk["pointsState"] => {
	switch (calc.score.delivery.state) {
		case "FRESH":
			return "LIVE";
		case "STALE":
			return "STALE";
		case "DEGRADED":
			// DEGRADED describes delivery fallback, not gameweek lifecycle. A
			// live event must not be presented as settling just because Redis or
			// PostgreSQL required an older complete snapshot.
			return "STALE";
		case "FINAL":
			return "FINAL";
		default:
			return "UNAVAILABLE";
	}
};

const scoreCanHeadline = (calc: LiveCalcDataV2 | undefined): boolean =>
	calc !== undefined &&
	calc.availability === "READY" &&
	calc.score.source !== "UNAVAILABLE" &&
	typeof calc.score.totalPoints === "number" &&
	calc.score.totalScope === "OVERALL";

export const applyHomeScoreLifecycle = (
	desk: HomePersonalDesk,
	event: Event | null,
	calc: LiveCalcDataV2 | undefined
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
			pointsCheckedAt: calc?.score.times?.sourceCheckedAt ?? null,
			rankState: "UPDATING",
		};
	}
	const finalRank = final ? (calc.rank?.overallRank ?? null) : null;
	return {
		...desk,
		overallPoints: calc.score.totalPoints,
		pointsState: pointsStateFromCalc(calc),
		pointsCheckedAt: calc.score.times?.sourceCheckedAt ?? null,
		overallRank: finalRank ?? desk.overallRank,
		rankState: finalRank === null ? "UPDATING" : "READY",
		rankCheckedAt: finalRank === null ? desk.rankCheckedAt : calc.score.times.sourceCheckedAt,
	};
};

type ComparablePairScore = {
	points: number;
	publicationId: string;
	scoreCore: string;
};

const pairScore = (calc: LiveCalcDataV2 | undefined): ComparablePairScore | null => {
	const revisions = calc?.score.revisions;
	return calc &&
		calc.availability === "READY" &&
		calc.score.source !== "UNAVAILABLE" &&
		typeof calc.score.netEventPoints === "number" &&
		revisions &&
		typeof revisions.publicationId === "string" &&
		typeof revisions.scoreCore === "string"
		? {
				points: calc.score.netEventPoints,
				publicationId: revisions.publicationId,
				scoreCore: revisions.scoreCore,
			}
		: null;
};

const compatiblePairScores = (
	viewer: LiveCalcDataV2 | undefined,
	opponent: LiveCalcDataV2 | undefined
): { viewer: number; opponent: number } | null => {
	const viewerScore = pairScore(viewer);
	const opponentScore = pairScore(opponent);
	if (
		!viewerScore ||
		!opponentScore ||
		viewerScore.publicationId !== opponentScore.publicationId ||
		viewerScore.scoreCore !== opponentScore.scoreCore
	)
		return null;
	return { viewer: viewerScore.points, opponent: opponentScore.points };
};

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
	results: BatchLiveCalcResultV2["results"]
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
			const pair = matchup.opponent.entryId ? compatiblePairScores(viewerCalc, opponentCalc) : null;
			return {
				...league,
				h2hMatchup: {
					...matchup,
					viewer: {
						...matchup.viewer,
						points: matchup.opponent.entryId ? (pair?.viewer ?? null) : null,
					},
					opponent: matchup.opponent.entryId
						? { ...matchup.opponent, points: pair?.opponent ?? null }
						: matchup.opponent,
					sourceCheckedAt: oldestCheckedAt(
						viewerCalc?.score.times?.sourceCheckedAt,
						opponentCalc?.score.times?.sourceCheckedAt
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

		let batch: BatchLiveCalcResultV2 | null = null;
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
				batch = await calcLivePointsForEntriesV2(context, event.id, entryIds);
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
		if (event && isFinalEvent(event)) {
			desk = await reconcileHomeOfficialH2HRanksV2(context, desk, event.id);
		}

		return desk;
	},
};
