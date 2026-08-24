import { createHash } from "node:crypto";
import { GraphQLError } from "graphql";
import type { GraphQLContext } from "../../graphql/context";
import type { Player, Team } from "../../infra/types";
import type { Entry } from "../entries/repository";
import { entriesService } from "../entries/service";
import type { Fixture } from "../fixtures/repository";
import { fixturesService } from "../fixtures/service";
import type { LivePerformance, TargetedLiveRead } from "../live/repository";
import { liveRepository } from "../live/repository";
import { loadLiveSnapshotMeta } from "../live/snapshot-meta";
import { playersRepository } from "../players/repository";
import {
	type ActiveCaptainData,
	buildNoPicksLiveCalcData,
	type ElementEventResultData,
	type LiveCalcData,
} from "./calc-service";
import {
	buildManagerScore,
	loadManagerScores,
	unavailableManagerScore,
	type OfficialManagerScoreRow,
} from "./manager-score";
import { eventsService } from "../events/service";
import type { EntryEventPick, EntryEventTransferRow } from "./repository";
import { entryLiveRepository, hasCompleteEntryEventPick } from "./repository";
import { resolvePreviousEventBaseline } from "./baseline";
import type { EntryEventResult } from "../entries/repository";
import {
	buildTeamMapById,
	type EntryEventTransfersData,
	enrichTransferRows,
} from "./transfer-enrichment";
import { stableStringify } from "../../infra/stringify";

export type BatchLiveCalcResult = {
	results: Map<number, LiveCalcData>;
	errors: Array<{ entryId: number; message: string }>;
	meta: {
		eventId: number;
		totalEntries: number;
		succeededCount: number;
		failedCount: number;
	};
};

const MAX_ENTRY_BATCH = 500;

export const assertValidEntryBatch = (entryIds: readonly number[]): void => {
	if (entryIds.length > MAX_ENTRY_BATCH) {
		throw new GraphQLError(`Entry batch exceeds the ${MAX_ENTRY_BATCH} entry limit`, {
			extensions: { code: "QUERY_TOO_COMPLEX" },
		});
	}
	if (new Set(entryIds).size !== entryIds.length) {
		throw new GraphQLError("Entry batch must not contain duplicate entry IDs", {
			extensions: { code: "DUPLICATE_ENTRY_IDS" },
		});
	}
};

type SharedData = {
	liveByPlayer: Map<number, LivePerformance>;
	teamsById: Map<number, Team>;
	playersById: Map<number, Player>;
	fixturesByTeam: Map<number, Fixture[]>;
};

type PerEntryData = {
	entryId: number;
	entry: Entry | null;
	pickEntity: EntryEventPick | null;
	transferRows: EntryEventTransferRow[];
	previousResult: EntryEventResult | null;
};

const PLAY_STATUS = {
	BLANK: 0,
	NOT_STARTED: 1,
	PLAYING: 2,
	EVENT_NOT_FINISHED: 3,
	FINISHED: 4,
} as const;

const safeInt = (value: number | null | undefined): number =>
	typeof value === "number" ? value : 0;

const asScaled = (value: number | null | undefined, divisor: number): number =>
	typeof value === "number" ? value / divisor : 0;

const safeNull = <T>(value: T | null | undefined, defaultValue: T): T => value ?? defaultValue;

const parseNullableFloat = (value: string | null | undefined): number | null => {
	if (!value) {
		return null;
	}
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : null;
};

const buildFinalManagerScoreRow = (
	season: string,
	eventId: number,
	entryId: number,
	finalized: EntryEventResult,
	checkedAt: string
): OfficialManagerScoreRow => ({
	season,
	eventId,
	entryId,
	eventPoints: finalized.eventPoints,
	netEventPoints: finalized.eventNetPoints,
	totalPoints: finalized.overallPoints,
	totalScope: "OVERALL",
	eventRank: finalized.eventRank,
	overallRank: finalized.overallRank,
	leagueRank: null,
	transferCost: finalized.eventTransfersCost,
	eventPointSemantics:
		finalized.eventPoints === finalized.eventNetPoints && finalized.eventTransfersCost === 0
			? "ZERO_COST_EQUIVALENT"
			: finalized.eventPoints - finalized.eventTransfersCost === finalized.eventNetPoints
				? "GROSS"
				: "UNKNOWN",
	source: "FPL_FINAL_RESULT",
	revision: `final:${eventId}:${entryId}:${finalized.overallPoints}:${finalized.overallRank}`,
	checkedAt,
	upstreamUpdatedAt: checkedAt,
	staleAt: new Date(Date.parse(checkedAt) + 90_000).toISOString(),
});

const finalizedPicksRevision = (eventId: number, results: readonly EntryEventResult[]): string => {
	const evidence = results
		.map((result) => ({ entryId: result.entryId, richSyncedAt: result.richSyncedAt }))
		.sort((left, right) => left.entryId - right.entryId);
	const digest = createHash("sha256")
		.update(stableStringify({ eventId, evidence }), "utf8")
		.digest("hex")
		.slice(0, 24);
	return `event-result:${eventId}:${digest}`;
};

const elementTypeName = (player: Player | null): string => {
	if (!player) return "";
	switch (player.position) {
		case 1:
			return "GKP";
		case 2:
			return "DEF";
		case 3:
			return "MID";
		case 4:
			return "FWD";
		default:
			return "";
	}
};

const buildFixtureIndex = (fixtures: Fixture[]): Map<number, Fixture[]> => {
	const map = new Map<number, Fixture[]>();
	for (const fx of fixtures) {
		const home = fx.teamHId;
		const away = fx.teamAId;
		const homeFixtures = map.get(home);
		if (homeFixtures) {
			homeFixtures.push(fx);
		} else {
			map.set(home, [fx]);
		}
		const awayFixtures = map.get(away);
		if (awayFixtures) {
			awayFixtures.push(fx);
		} else {
			map.set(away, [fx]);
		}
	}
	return map;
};

const getPlayStatusForTeam = (
	fixtures: Fixture[] | undefined
): { started: boolean; finished: boolean; status: number } => {
	if (!fixtures || fixtures.length === 0) {
		return { started: true, finished: true, status: PLAY_STATUS.BLANK };
	}
	const anyStarted = fixtures.some((f) => f.started === true);
	const anyFinished = fixtures.some((f) => f.finished === true);
	const allFinished = fixtures.every((f) => f.finished === true);

	if (anyStarted && !allFinished) {
		return { started: true, finished: false, status: PLAY_STATUS.PLAYING };
	}
	if (!anyStarted && !anyFinished) {
		return { started: false, finished: false, status: PLAY_STATUS.NOT_STARTED };
	}
	if (anyFinished && !allFinished) {
		return {
			started: true,
			finished: false,
			status: PLAY_STATUS.EVENT_NOT_FINISHED,
		};
	}
	return { started: true, finished: true, status: PLAY_STATUS.FINISHED };
};

const joinNonEmpty = (values: string[]): string =>
	values.filter((s) => s.trim().length > 0).join(",");

const buildTeamMatchInfo = (params: {
	teamId: number;
	team: Team | undefined;
	fixtures: Fixture[] | undefined;
	teamsById: Map<number, Team>;
}): {
	teamCode: number;
	teamName: string;
	teamShortName: string;
	againstId: number;
	againstName: string;
	againstShortName: string;
	wasHome: string;
	score: string;
	bgw: boolean;
	dgw: boolean;
	isGwStarted: boolean;
	isGwFinished: boolean;
	playStatus: number;
} => {
	const { fixtures, teamId, team, teamsById } = params;
	const status = getPlayStatusForTeam(fixtures);

	if (!fixtures || fixtures.length === 0) {
		return {
			teamCode: team?.code ?? 0,
			teamName: team?.name ?? "",
			teamShortName: team?.shortName ?? "",
			againstId: 0,
			againstName: "BLANK",
			againstShortName: "BLANK",
			wasHome: "",
			score: "",
			bgw: true,
			dgw: false,
			isGwStarted: true,
			isGwFinished: true,
			playStatus: PLAY_STATUS.BLANK,
		};
	}

	const againstIds: number[] = [];
	const againstNames: string[] = [];
	const againstShortNames: string[] = [];
	const wasHomeList: string[] = [];
	const scores: string[] = [];

	for (const fx of fixtures) {
		const isHome = fx.teamHId === teamId;
		const againstId = isHome ? fx.teamAId : fx.teamHId;
		const againstTeam = teamsById.get(againstId);

		againstIds.push(againstId);
		againstNames.push(againstTeam?.name ?? "");
		againstShortNames.push(againstTeam?.shortName ?? "");
		wasHomeList.push(isHome ? "H" : "A");

		const teamScore = isHome ? fx.teamHScore : fx.teamAScore;
		const againstScore = isHome ? fx.teamAScore : fx.teamHScore;
		scores.push(teamScore === null || againstScore === null ? "" : `${teamScore}-${againstScore}`);
	}

	return {
		teamCode: team?.code ?? 0,
		teamName: team?.name ?? "",
		teamShortName: team?.shortName ?? "",
		againstId: againstIds.length === 1 ? againstIds[0] : 0,
		againstName: joinNonEmpty(againstNames),
		againstShortName: joinNonEmpty(againstShortNames),
		wasHome: joinNonEmpty(wasHomeList),
		score: joinNonEmpty(scores),
		bgw: false,
		dgw: fixtures.length > 1,
		isGwStarted: status.started,
		isGwFinished: status.finished,
		playStatus: status.status,
	};
};

const normalizeChip = (raw: string | null | undefined): string => {
	const value = (raw ?? "").toUpperCase().trim();
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
	if (value === "FREE_HIT" || compactValue === "FREEHIT" || compactValue === "FH")
		return "FREE_HIT";
	if (value === "WILDCARD" || compactValue === "WILDCARD" || compactValue === "WC")
		return "WILDCARD";
	if (compactValue === "NONE" || compactValue === "NA" || compactValue === "") return "NONE";
	return "NONE";
};

const computeSingleEntry = (
	entryId: number,
	eventId: number,
	perEntry: PerEntryData,
	shared: SharedData,
	provisional: boolean
): LiveCalcData => {
	const { entry, pickEntity, transferRows, previousResult } = perEntry;
	const { liveByPlayer, fixturesByTeam, teamsById, playersById } = shared;

	const chip = normalizeChip(pickEntity?.chip ?? null);
	const transferCost = pickEntity?.transfersCost ?? 0;

	const picks = pickEntity?.picks ?? [];

	const pickList: ElementEventResultData[] = picks.map((pick) => {
		const player = playersById.get(pick.element) ?? null;
		const team = player ? teamsById.get(player.teamId) : undefined;
		const teamFixtures = player ? fixturesByTeam.get(player.teamId) : undefined;
		const matchInfo = buildTeamMatchInfo({
			teamId: player?.teamId ?? 0,
			team,
			fixtures: teamFixtures,
			teamsById,
		});

		const live = liveByPlayer.get(pick.element);
		const elementType = player?.position ?? 0;

		const minutes = safeNull(live?.minutes, 0);
		const yellowCards = safeNull(live?.yellowCards, 0);
		const redCards = safeNull(live?.redCards, 0);
		const isPlayed = minutes > 0 || yellowCards > 0 || redCards > 0;

		const defensiveContribution: number = safeNull(live?.defensiveContribution, 0);
		// Official event/{gw}/live total_points is authoritative, including projected
		// and final bonus. Never reconstruct scoring locally.
		const officialTotalPoints = live?.totalPoints ?? 0;

		return {
			season: null,
			event: eventId,
			element: pick.element,
			code: player?.code ?? 0,
			webName: player?.webName ?? "",
			price: player ? player.price / 10 : 0,
			elementType,
			elementTypeName: elementTypeName(player),
			teamId: player?.teamId ?? 0,
			teamCode: matchInfo.teamCode,
			teamName: matchInfo.teamName,
			teamShortName: matchInfo.teamShortName,
			againstId: matchInfo.againstId,
			againstName: matchInfo.againstName,
			againstShortName:
				matchInfo.againstShortName.length > 0 ? matchInfo.againstShortName : "BLANK",
			wasHome: matchInfo.wasHome,
			score: matchInfo.score,
			position: pick.position,
			multiplier: pick.multiplier,
			isCaptain: pick.isCaptain,
			isViceCaptain: pick.isViceCaptain,
			isGwStarted: matchInfo.isGwStarted,
			isGwFinished: matchInfo.isGwFinished,
			isPlayed,
			playStatus: matchInfo.playStatus,
			minutes,
			goalsScored: safeNull(live?.goalsScored, 0),
			assists: safeNull(live?.assists, 0),
			cleanSheets: safeNull(live?.cleanSheets, 0),
			goalsConceded: safeNull(live?.goalsConceded, 0),
			defensiveContribution,
			ownGoals: safeNull(live?.ownGoals, 0),
			penaltiesSaved: safeNull(live?.penaltiesSaved, 0),
			penaltiesMissed: safeNull(live?.penaltiesMissed, 0),
			yellowCards,
			redCards,
			saves: safeNull(live?.saves, 0),
			bonus: safeNull(live?.bonus, 0),
			bps: safeNull(live?.bps, 0),
			totalPoints: officialTotalPoints,
			starts: live?.starts ?? null,
			expectedGoals: parseNullableFloat(live?.expectedGoals),
			expectedAssists: parseNullableFloat(live?.expectedAssists),
			expectedGoalInvolvements: parseNullableFloat(live?.expectedGoalInvolvements),
			expectedGoalsConceded: parseNullableFloat(live?.expectedGoalsConceded),
			inDreamTeam: live?.inDreamTeam ?? null,
			pickActive: false,
			autoSub: false,
			bgw: matchInfo.bgw,
			dgw: matchInfo.dgw,
		};
	});

	const isBenchBoost = chip === "BENCH_BOOST";
	const activePicks: ElementEventResultData[] = [];

	for (const pick of pickList) {
		// Official FPL picks multipliers are the only source of truth for the
		// current/final lineup. Never infer auto-subs or captain promotion from
		// minutes, fixture state, bench order, or chip names in the live path.
		const isActive = pick.multiplier > 0;
		// After finalization, the official multiplier is authoritative for the
		// display-only bench relation. During live/settling we deliberately leave
		// this false instead of predicting an automatic substitution.
		const autoSub = !provisional && !isBenchBoost && pick.position > 11 && pick.multiplier > 0;
		pick.pickActive = isActive;
		pick.autoSub = autoSub;
		if (isActive) {
			activePicks.push(pick);
		}
	}

	const captainForScoring =
		pickList.find((pick) => pick.multiplier >= 2) ??
		pickList.find((pick) => pick.isCaptain) ??
		null;
	// The multiplier already carries captain/bench-boost/triple-captain
	// semantics. Applying another captain multiplier would double-count points.
	const livePoints = activePicks.reduce((sum, p) => sum + p.totalPoints * p.multiplier, 0);

	const liveNetPoints = livePoints - transferCost;
	const baseline = resolvePreviousEventBaseline(entry, eventId, previousResult);
	const lastOverallPoints = baseline.overallPoints;
	const lastOverallRank = baseline.overallRank ?? 0;
	const lastValue = asScaled(baseline.teamValue, 10);
	const liveTotalPoints = lastOverallPoints + liveNetPoints;

	const played = activePicks.filter((p) => p.isPlayed || p.bgw || p.isGwFinished).length;
	const toPlay = activePicks.filter((p) => !p.isGwStarted && !p.isGwFinished && !p.bgw).length;

	const playedCaptain = captainForScoring?.element ?? 0;
	const captainName = captainForScoring?.webName ?? "";
	const activeCaptain: ActiveCaptainData = {
		id: captainForScoring?.element ?? 0,
		name: captainForScoring?.webName ?? "",
		points: captainForScoring?.totalPoints ?? 0,
	};

	const transfersList: EntryEventTransfersData[] = enrichTransferRows({
		entryId,
		eventId,
		transferRows,
		playersById,
		teamsById,
		liveByPlayer,
	});

	return {
		availability: pickEntity && pickEntity.picks.length > 0 ? "READY" : "NO_PICKS",
		provisional,
		snapshot: null,
		score: unavailableManagerScore(transferCost),
		rank: 0,
		event: eventId,
		entry: entryId,
		entryName: entry?.entryName ?? "",
		playerName: entry?.playerName ?? "",
		region: entry?.region ?? null,
		startedEvent: safeInt(entry?.startedEvent),
		overallPoints: safeInt(entry?.overallPoints),
		overallRank: safeInt(entry?.overallRank),
		value: asScaled(entry?.teamValue ?? null, 10),
		bank: asScaled(entry?.bank ?? null, 10),
		teamValue: asScaled(entry?.teamValue ?? null, 10),
		totalTransfers: safeInt(entry?.totalTransfers),
		lastOverallPoints,
		lastOverallRank,
		lastValue,
		chip,
		livePoints,
		transferCost,
		liveNetPoints,
		liveTotalPoints,
		played,
		toPlay,
		playedCaptain,
		captainName,
		pickList: [...pickList].sort((a, b) => a.position - b.position),
		transfersList,
		activeCaptain,
	};
};

export const entryLiveBatchService = {
	async calcLivePointsForEntries(
		context: GraphQLContext,
		eventId: number,
		entryIds: number[],
		_includeLive = true,
		prefetched?: {
			liveByPlayer?: Promise<Map<number, LivePerformance>>;
			fixtures?: Promise<Fixture[]>;
			teams?: Promise<Team[]>;
			picksByEntry?: Promise<Map<number, EntryEventPick>>;
			tournamentId?: number;
		}
	): Promise<BatchLiveCalcResult> {
		assertValidEntryBatch(entryIds);
		const errors: Array<{ entryId: number; message: string }> = [];

		if (!entryIds.length) {
			return {
				results: new Map(),
				errors: [],
				meta: { eventId, totalEntries: 0, succeededCount: 0, failedCount: 0 },
			};
		}

		// Phase 1: resolve identity and picks. Entries without picks must not enter
		// Live, fixture, player, transfer or bonus acquisition.
		const [entriesById, picksByEntry, previousResultsByEntry, managerScores, event] =
			await Promise.all([
				entriesService.getEntriesByIds(context, entryIds),
				prefetched?.picksByEntry ??
					entryLiveRepository.getEntryEventPicksByIds(context, entryIds, eventId),
				eventId > 1
					? entriesService.getEntryEventResultsByEntryIds(context, entryIds, eventId - 1)
					: Promise.resolve(new Map<number, EntryEventResult>()),
				loadManagerScores(context, eventId, entryIds, prefetched?.tournamentId),
				eventsService.getEventById(context, eventId).catch(() => null),
			]);
		// Manager headline availability is independent from lineup availability.
		// Keep NO_PICKS metadata cheap while still resolving the official manager
		// score; final lifecycle evidence requires a persisted lineup/result pair.
		const provisional = !(event?.finished === true && event.dataChecked === true);
		let finalizedResultsByEntry = new Map<number, EntryEventResult>();
		if (!provisional) {
			// FPL can publish automatic_subs and the effective captain after the
			// event flips to finished/data_checked. Read through a finalization-scoped
			// cache key so the canonical picks are refreshed once, then remain stable.
			const finalizedResults = await entriesService.getEntryEventResultsByEntryIds(
				context,
				entryIds,
				eventId
			);
			finalizedResultsByEntry = finalizedResults;
			const durableEntryIds = entryIds.filter((entryId) => finalizedResults.has(entryId));
			const settlingEntryIds = entryIds.filter((entryId) => !finalizedResults.has(entryId));
			const durableResults = durableEntryIds
				.map((entryId) => finalizedResults.get(entryId))
				.filter((result): result is EntryEventResult => result !== undefined);
			const [durablePicks, settlingPicks] = await Promise.all([
				durableEntryIds.length > 0
					? entryLiveRepository.getEntryEventPicksByIds(
							context,
							durableEntryIds,
							eventId,
							false,
							finalizedPicksRevision(eventId, durableResults)
						)
					: Promise.resolve(new Map<number, EntryEventPick>()),
				settlingEntryIds.length > 0
					? entryLiveRepository.getEntryEventPicksByIds(context, settlingEntryIds, eventId, true)
					: Promise.resolve(new Map<number, EntryEventPick>()),
			]);
			for (const [entryId, pick] of [...durablePicks, ...settlingPicks]) {
				picksByEntry.set(entryId, pick);
			}
		}
		const readyEntryIds = entryIds.filter((entryId) =>
			hasCompleteEntryEventPick(picksByEntry.get(entryId), eventId, entryId)
		);
		const readyEntryIdSet = new Set(readyEntryIds);
		const results = new Map<number, LiveCalcData>();
		for (const entryId of entryIds) {
			if (!readyEntryIdSet.has(entryId)) {
				const entry = entriesById.get(entryId) ?? null;
				const previousResult = previousResultsByEntry.get(entryId) ?? null;
				const baseline = resolvePreviousEventBaseline(entry, eventId, previousResult);
				const finalized = finalizedResultsByEntry.get(entryId);
				const finalRow = finalized
					? buildFinalManagerScoreRow(
							context.currentSeason.seasonCode,
							eventId,
							entryId,
							finalized,
							finalized.richSyncedAt
						)
					: undefined;
				const noPicks = buildNoPicksLiveCalcData(entryId, eventId, entry, previousResult);
				const manager = buildManagerScore({
					row: finalRow ?? managerScores.rows.get(entryId),
					upstreamErrorCode: managerScores.errorCode,
					provisional,
					available: false,
					transferCost: finalized?.eventTransfersCost ?? 0,
					detailEventPoints: finalized?.eventPoints ?? 0,
					previousOverallPoints: finalized
						? finalized.overallPoints - finalized.eventNetPoints
						: baseline.resolved
							? baseline.overallPoints
							: null,
					nextRefreshAt: managerScores.nextRefreshAt,
				});
				results.set(entryId, {
					...noPicks,
					provisional,
					score: manager.score,
					rank: manager.headline.rank,
					eventTransfers: finalized?.eventTransfers,
					transferCost: manager.score.transferCost,
					chip: normalizeChip(finalized?.eventChip ?? noPicks.chip),
					lastOverallPoints: finalized
						? finalized.overallPoints - finalized.eventNetPoints
						: noPicks.lastOverallPoints,
					livePoints: manager.headline.livePoints,
					liveNetPoints: manager.headline.liveNetPoints,
					liveTotalPoints: manager.headline.liveTotalPoints,
				});
			}
		}
		if (readyEntryIds.length === 0) {
			return {
				results,
				errors,
				meta: {
					eventId,
					totalEntries: entryIds.length,
					succeededCount: results.size,
					failedCount: 0,
				},
			};
		}

		// Phase 2: load reusable data only for entries that actually have picks.
		// Finalized and historical desks still need the durable player projection
		// for detail rows. Only the manager headline switches to the official final
		// result; suppressing this read made finalized entries silently lose details.
		// A caller may omit the heavy display detail, but every active score still
		// requires the coherent event-live payload. includeLive is never allowed to
		// switch the manager headline to another scoring source.
		const needsLiveDetails = readyEntryIds.length > 0;
		const useTargetedLiveRead =
			needsLiveDetails && readyEntryIds.length === 1 && prefetched?.liveByPlayer === undefined;
		const [liveByPlayerRaw, fixtures, teams, transfersByEntry, fullSnapshotMeta] =
			await Promise.all([
				prefetched?.liveByPlayer ??
					(needsLiveDetails && !useTargetedLiveRead
						? liveRepository.getAllLivePerformances(context, eventId)
						: Promise.resolve(new Map<number, LivePerformance>())),
				prefetched?.fixtures ?? fixturesService.getEventFixtures(context, eventId),
				prefetched?.teams ?? playersRepository.listTeams(context),
				entryLiveRepository.getEntryEventTransfersByIds(context, readyEntryIds, eventId),
				needsLiveDetails && !useTargetedLiveRead
					? loadLiveSnapshotMeta(context, eventId)
					: Promise.resolve(null),
			]);

		// Collect all unique player IDs from picks and transfers
		const allPlayerIds = new Set<number>();
		for (const entryId of readyEntryIds) {
			const picks = picksByEntry.get(entryId);
			if (!picks) continue;
			for (const pick of picks.picks) allPlayerIds.add(pick.element);
		}
		for (const [, rows] of transfersByEntry) {
			for (const row of rows) {
				allPlayerIds.add(row.elementIn);
				allPlayerIds.add(row.elementOut);
			}
		}

		// Load only the needed players via HMGET (not HGETALL of all 600+)
		const playerIds = Array.from(allPlayerIds);
		let targetedLiveError: Error | null = null;
		const loadTargetedLive = async (): Promise<TargetedLiveRead | null> => {
			if (!useTargetedLiveRead) return null;
			const stopSnapshot = context.requestTiming?.start("entryLive.liveSnapshot");
			try {
				return await liveRepository.getTargetedLiveRead(context, eventId, playerIds);
			} catch (error) {
				targetedLiveError = error instanceof Error ? error : new Error("Live data unavailable");
				context.logger.info(
					{ eventId, err: error instanceof Error ? error.message : "unknown" },
					"Targeted live read unavailable; marking entries partial"
				);
				return null;
			} finally {
				stopSnapshot?.();
			}
		};
		const [playersList, targetedLive] = await Promise.all([
			playersRepository.getPlayersByIds(context, playerIds),
			loadTargetedLive(),
		]);
		const liveByPlayerMap = useTargetedLiveRead
			? new Map(
					(targetedLive?.performances ?? []).map((performance) => [
						performance.playerId,
						performance,
					])
				)
			: new Map(liveByPlayerRaw);

		const playersById = new Map<number, Player>();
		for (const p of playersList) {
			playersById.set(p.id, {
				id: p.id,
				webName: p.webName,
				firstName: p.firstName,
				secondName: p.secondName,
				position: p.position as number,
				teamId: p.teamId,
				code: p.code,
				price: p.price,
				startPrice: p.startPrice,
				totalPoints: p.totalPoints,
				selectedByPercent: p.selectedByPercent,
			});
		}

		const teamsById = buildTeamMapById(teams);
		const fixturesByTeam = buildFixtureIndex(fixtures);

		const shared: SharedData = {
			liveByPlayer: liveByPlayerMap,
			teamsById,
			playersById,
			fixturesByTeam,
		};

		// Phase 4: Compute per-entry (pure CPU, zero I/O)
		for (const entryId of readyEntryIds) {
			try {
				if (targetedLiveError) throw targetedLiveError;
				const perEntry: PerEntryData = {
					entryId,
					entry: entriesById.get(entryId) ?? null,
					pickEntity: picksByEntry.get(entryId) ?? null,
					transferRows: transfersByEntry.get(entryId) ?? [],
					previousResult: previousResultsByEntry.get(entryId) ?? null,
				};

				const calcData = {
					...computeSingleEntry(entryId, eventId, perEntry, shared, provisional),
					snapshot: targetedLive?.meta ?? fullSnapshotMeta,
				};
				const finalized = finalizedResultsByEntry.get(entryId);
				const finalRow = finalized
					? buildFinalManagerScoreRow(
							context.currentSeason.seasonCode,
							eventId,
							entryId,
							finalized,
							finalized.richSyncedAt
						)
					: undefined;
				const baseline = resolvePreviousEventBaseline(
					perEntry.entry,
					eventId,
					perEntry.previousResult
				);
				const manager = buildManagerScore({
					row: finalRow ?? managerScores.rows.get(entryId),
					upstreamErrorCode: managerScores.errorCode,
					provisional,
					available: true,
					transferCost: calcData.transferCost,
					detailEventPoints: calcData.livePoints,
					previousOverallPoints: finalized
						? finalized.overallPoints - finalized.eventNetPoints
						: baseline.resolved
							? baseline.overallPoints
							: null,
					eventLiveAuthority: calcData.snapshot
						? {
								revision: calcData.snapshot.revision,
								checkedAt: calcData.snapshot.checkedAt,
							}
						: null,
					nextRefreshAt: managerScores.nextRefreshAt,
				});
				results.set(entryId, {
					...calcData,
					score: manager.score,
					rank: manager.headline.rank,
					eventTransfers: finalized?.eventTransfers ?? calcData.transfersList.length,
					transferCost: manager.score.transferCost,
					livePoints: manager.headline.livePoints,
					liveNetPoints: manager.headline.liveNetPoints,
					liveTotalPoints: manager.headline.liveTotalPoints,
					overallRank: manager.score.overallRank ?? calcData.overallRank,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : "Computation error";
				errors.push({ entryId, message });
			}
		}

		const orderedResults = new Map<number, LiveCalcData>();
		for (const entryId of entryIds) {
			const result = results.get(entryId);
			if (result) orderedResults.set(entryId, result);
		}

		return {
			results: orderedResults,
			errors,
			meta: {
				eventId,
				totalEntries: entryIds.length,
				succeededCount: orderedResults.size,
				failedCount: errors.length,
			},
		};
	},
};
