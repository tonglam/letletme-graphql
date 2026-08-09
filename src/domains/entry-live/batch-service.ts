import { GraphQLError } from "graphql";
import type { GraphQLContext } from "../../graphql/context";
import type { Player, Team } from "../../infra/types";
import type { Entry } from "../entries/repository";
import { entriesService } from "../entries/service";
import type { Fixture } from "../fixtures/repository";
import { fixturesService } from "../fixtures/service";
import type { LivePerformance } from "../live/repository";
import { liveRepository } from "../live/repository";
import { loadLiveBonusByPlayerId } from "../live/bonus-cache";
import { playersRepository } from "../players/repository";
import {
	type ActiveCaptainData,
	applyAutoSubs,
	calcElementLivePoints,
	type ElementEventResultData,
	type LiveCalcData,
} from "./calc-service";
import type { EntryEventPick, EntryEventTransferRow } from "./repository";
import { entryLiveRepository } from "./repository";
import { resolvePreviousEventBaseline } from "./baseline";
import type { EntryEventResult } from "../entries/repository";
import {
	buildTeamMapById,
	type EntryEventTransfersData,
	enrichTransferRows,
} from "./transfer-enrichment";

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
	effectiveBonusByPlayer: Map<number, number>;
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

const hasCompletedFixtures = (pick: ElementEventResultData): boolean =>
	pick.isGwFinished || pick.playStatus === PLAY_STATUS.BLANK || pick.bgw;

const selectCaptainForScoring = (
	picks: ElementEventResultData[]
): ElementEventResultData | null => {
	const captain = picks.find((p) => p.isCaptain) ?? null;
	if (!captain) {
		return null;
	}
	if (captain.isPlayed) {
		return captain;
	}
	if (!hasCompletedFixtures(captain)) {
		return captain;
	}
	const vice = picks.find((p) => p.isViceCaptain) ?? null;
	return vice ?? captain;
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
	shared: SharedData
): LiveCalcData => {
	const { entry, pickEntity, transferRows, previousResult } = perEntry;
	const { liveByPlayer, effectiveBonusByPlayer, fixturesByTeam, teamsById, playersById } = shared;

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
		const effectiveBonus = effectiveBonusByPlayer.get(pick.element);
		const calculatedTotalPoints = calcElementLivePoints(elementType, live, effectiveBonus);

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
			bonus: effectiveBonus ?? safeNull(live?.bonus, 0),
			bps: safeNull(live?.bps, 0),
			totalPoints: calculatedTotalPoints,
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

	// Apply automatic substitutions before building active picks
	applyAutoSubs(pickList, chip);

	const isBenchBoost = chip === "BENCH_BOOST";
	const activePicks: ElementEventResultData[] = [];

	for (const pick of pickList) {
		const isActive = isBenchBoost ? true : pick.multiplier > 0;
		const autoSub = !isBenchBoost && pick.position > 11 && pick.multiplier > 0;
		pick.pickActive = isActive;
		pick.autoSub = autoSub;
		if (isActive) {
			activePicks.push(pick);
		}
	}

	// Captain selection uses full pickList so vice-captain is found even if
	// captain was auto-subbed out
	const captainForScoring = selectCaptainForScoring(pickList);
	const captainMultiplier = chip === "TRIPLE_CAPTAIN" ? 3 : 2;

	const captainElementId = captainForScoring?.element;
	const livePoints = activePicks.reduce((sum, p) => {
		if (captainElementId !== undefined && p.element === captainElementId) {
			return sum + p.totalPoints * captainMultiplier;
		}
		return sum + p.totalPoints;
	}, 0);

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
		teamValue: asScaled(
			(entry?.teamValue ?? null) !== null && (entry?.bank ?? null) !== null
				? safeInt(entry?.teamValue) - safeInt(entry?.bank)
				: null,
			10
		),
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
		includeLive = true,
		prefetched?: {
			liveByPlayer?: Promise<Map<number, LivePerformance>>;
			fixtures?: Promise<Fixture[]>;
			teams?: Promise<Team[]>;
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

		// Phase 1: Load reusable data and all entry data in parallel. A single-entry
		// request defers live points until its 15 picks are known, avoiding a
		// 700-player shaped-cache decode on every browser refresh.
		const useTargetedLiveRead =
			includeLive && entryIds.length === 1 && prefetched?.liveByPlayer === undefined;
		const [
			liveByPlayerRaw,
			bonusByPlayerId,
			fixtures,
			teams,
			entriesById,
			picksByEntry,
			transfersByEntry,
			previousResultsByEntry,
		] = await Promise.all([
			prefetched?.liveByPlayer ??
				(includeLive && !useTargetedLiveRead
					? liveRepository.getAllLivePerformances(context, eventId)
					: Promise.resolve(new Map<number, LivePerformance>())),
			includeLive
				? loadLiveBonusByPlayerId(context, eventId)
				: Promise.resolve(new Map<number, number>()),
			prefetched?.fixtures ?? fixturesService.getEventFixtures(context, eventId),
			prefetched?.teams ?? playersRepository.listTeamsFromRedis(context),
			// Phase 2 moved here: entry info HMGET
			entriesService.getEntriesByIdsFromRedis(context, entryIds),
			// Phase 3 moved here: picks + transfers (MGET cache or SQL)
			entryLiveRepository.getEntryEventPicksByIds(context, entryIds, eventId),
			entryLiveRepository.getEntryEventTransfersByIds(context, entryIds, eventId),
			eventId > 1
				? entriesService.getEntryEventResultsByEntryIds(context, entryIds, eventId - 1)
				: Promise.resolve(new Map<number, EntryEventResult>()),
		]);

		// Collect all unique player IDs from picks and transfers
		const allPlayerIds = new Set<number>();
		for (const [, picks] of picksByEntry) {
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
		const [playersList, targetedLivePerformances] = await Promise.all([
			playersRepository.getPlayersByIds(context, playerIds),
			useTargetedLiveRead
				? liveRepository.getLivePerformancesByPlayerIds(context, eventId, playerIds)
				: Promise.resolve([] as LivePerformance[]),
		]);
		const liveByPlayerMap = useTargetedLiveRead
			? new Map(targetedLivePerformances.map((performance) => [performance.playerId, performance]))
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
			effectiveBonusByPlayer: bonusByPlayerId,
			teamsById,
			playersById,
			fixturesByTeam,
		};

		// Phase 4: Compute per-entry (pure CPU, zero I/O)
		const results = new Map<number, LiveCalcData>();

		for (const entryId of entryIds) {
			try {
				const perEntry: PerEntryData = {
					entryId,
					entry: entriesById.get(entryId) ?? null,
					pickEntity: picksByEntry.get(entryId) ?? null,
					transferRows: transfersByEntry.get(entryId) ?? [],
					previousResult: previousResultsByEntry.get(entryId) ?? null,
				};

				const calcData = computeSingleEntry(entryId, eventId, perEntry, shared);
				results.set(entryId, calcData);
			} catch (err) {
				const message = err instanceof Error ? err.message : "Computation error";
				errors.push({ entryId, message });
			}
		}

		return {
			results,
			errors,
			meta: {
				eventId,
				totalEntries: entryIds.length,
				succeededCount: results.size,
				failedCount: errors.length,
			},
		};
	},
};
