import type { GraphQLContext } from "../../graphql/context";
import type { Entry, EntryEventResult } from "../entries/repository";
import { entriesService } from "../entries/service";
import type { LivePerformance } from "../live/repository";
import type { LiveSnapshotMeta } from "../live/snapshot-meta";
import { resolvePreviousEventBaseline } from "./baseline";
import type { EntryEventTransfersData } from "./transfer-enrichment";
import { entryLiveRepository } from "./repository";

export type EntryLiveAvailability = "READY" | "NO_PICKS";

export type ActiveCaptainData = {
	id: number;
	name: string;
	points: number;
};

export type LiveCalcData = {
	availability: EntryLiveAvailability;
	snapshot: LiveSnapshotMeta | null;
	rank: number;
	event: number;
	entry: number;
	entryName: string;
	playerName: string;
	region: string | null;
	startedEvent: number;
	overallPoints: number;
	overallRank: number;
	value: number;
	bank: number;
	teamValue: number;
	totalTransfers: number;
	lastOverallPoints: number;
	lastOverallRank: number;
	lastValue: number;
	chip: string;
	livePoints: number;
	transferCost: number;
	liveNetPoints: number;
	liveTotalPoints: number;
	played: number;
	toPlay: number;
	playedCaptain: number;
	captainName: string;
	pickList: ElementEventResultData[];
	transfersList: EntryEventTransfersData[];
	activeCaptain: ActiveCaptainData;
};

export type ElementEventResultData = {
	season: string | null;
	event: number;
	element: number;
	code: number;
	webName: string;
	price: number;
	elementType: number;
	elementTypeName: string;
	teamId: number;
	teamCode: number;
	teamName: string;
	teamShortName: string;
	againstId: number;
	againstName: string;
	againstShortName: string;
	wasHome: string;
	score: string;
	position: number;
	multiplier: number;
	isCaptain: boolean;
	isViceCaptain: boolean;
	isGwStarted: boolean;
	isGwFinished: boolean;
	isPlayed: boolean;
	playStatus: number;
	minutes: number;
	goalsScored: number;
	assists: number;
	cleanSheets: number;
	goalsConceded: number;
	defensiveContribution: number;
	ownGoals: number;
	penaltiesSaved: number;
	penaltiesMissed: number;
	yellowCards: number;
	redCards: number;
	saves: number;
	bonus: number;
	bps: number;
	totalPoints: number;
	starts: boolean | null;
	expectedGoals: number | null;
	expectedAssists: number | null;
	expectedGoalInvolvements: number | null;
	expectedGoalsConceded: number | null;
	inDreamTeam: boolean | null;
	pickActive: boolean;
	autoSub: boolean;
	bgw: boolean;
	dgw: boolean;
};

/**
 * Preserve FPL's official fixture-level scoring and rounding, replacing only
 * the aggregate bonus while provisional BPS is being estimated.
 */
export const calcOfficialTotalWithEffectiveBonus = (
	live: LivePerformance | undefined,
	effectiveBonus?: number
): number => {
	if (!live) return 0;
	const officialTotal =
		typeof live.totalPoints === "number" && Number.isFinite(live.totalPoints)
			? live.totalPoints
			: 0;
	const officialBonus =
		typeof live.bonus === "number" && Number.isFinite(live.bonus) ? live.bonus : 0;
	return officialTotal - officialBonus + (effectiveBonus ?? officialBonus);
};

export const calcElementLivePoints = (
	live: LivePerformance | undefined,
	effectiveBonus?: number
): number => calcOfficialTotalWithEffectiveBonus(live, effectiveBonus);

/**
 * Apply FPL automatic substitutions.
 *
 * Rules:
 * - No auto-subs during Bench Boost (all 15 count)
 * - Bench players evaluated in order (position 12, 13, 14, 15)
 * - Bench player must have played (>0 minutes) to come on
 * - Replaces a non-playing starter (0 minutes, multiplier > 0)
 * - Formation must remain valid after substitution
 */
export const applyAutoSubs = (pickList: ElementEventResultData[], chip: string): void => {
	if (chip === "BENCH_BOOST") return;

	const starters = pickList.filter((pick) => pick.position <= 11);
	const bench = pickList
		.filter((pick) => pick.position > 11)
		.sort((left, right) => left.position - right.position);
	const nonPlayingStarters = starters.filter(
		(pick) => pick.minutes === 0 && pick.multiplier > 0 && (pick.isGwFinished || pick.bgw)
	);

	const isValidFormation = (active: ElementEventResultData[]): boolean => {
		const goalkeeperCount = active.filter((pick) => pick.elementType === 1).length;
		const defenderCount = active.filter((pick) => pick.elementType === 2).length;
		const midfielderCount = active.filter((pick) => pick.elementType === 3).length;
		const forwardCount = active.filter((pick) => pick.elementType === 4).length;
		return (
			goalkeeperCount === 1 &&
			defenderCount >= 3 &&
			defenderCount <= 5 &&
			midfielderCount >= 2 &&
			midfielderCount <= 5 &&
			forwardCount >= 1 &&
			forwardCount <= 3
		);
	};

	for (const benchPlayer of bench) {
		if (benchPlayer.minutes === 0) continue;
		if (nonPlayingStarters.length === 0) break;

		for (let index = 0; index < nonPlayingStarters.length; index += 1) {
			const starter = nonPlayingStarters[index];
			const originalStarterMultiplier = starter.multiplier;
			const originalBenchMultiplier = benchPlayer.multiplier;

			starter.multiplier = 0;
			benchPlayer.multiplier = 1;
			if (isValidFormation(pickList.filter((pick) => pick.multiplier > 0))) {
				nonPlayingStarters.splice(index, 1);
				break;
			}

			starter.multiplier = originalStarterMultiplier;
			benchPlayer.multiplier = originalBenchMultiplier;
		}
	}
};

const scaledEntryValue = (value: number | null | undefined): number =>
	typeof value === "number" ? value / 10 : 0;

export const buildNoPicksLiveCalcData = (
	entryId: number,
	eventId = 0,
	entry: Entry | null = null,
	previousResult: EntryEventResult | null = null
): LiveCalcData => {
	const baseline = resolvePreviousEventBaseline(entry, eventId, previousResult);
	return {
		availability: "NO_PICKS",
		snapshot: null,
		rank: 0,
		event: eventId,
		entry: entryId,
		entryName: entry?.entryName ?? "",
		playerName: entry?.playerName ?? "",
		region: entry?.region ?? null,
		startedEvent: entry?.startedEvent ?? 0,
		overallPoints: entry?.overallPoints ?? 0,
		overallRank: entry?.overallRank ?? 0,
		value: scaledEntryValue(entry?.teamValue),
		bank: scaledEntryValue(entry?.bank),
		teamValue: scaledEntryValue(
			entry?.teamValue !== null && entry?.teamValue !== undefined && entry.bank !== null
				? entry.teamValue - (entry.bank ?? 0)
				: null
		),
		totalTransfers: entry?.totalTransfers ?? 0,
		lastOverallPoints: baseline.overallPoints,
		lastOverallRank: baseline.overallRank ?? 0,
		lastValue: scaledEntryValue(baseline.teamValue),
		chip: "NONE",
		livePoints: 0,
		transferCost: 0,
		liveNetPoints: 0,
		liveTotalPoints: baseline.overallPoints,
		played: 0,
		toPlay: 0,
		playedCaptain: 0,
		captainName: "",
		pickList: [],
		transfersList: [],
		activeCaptain: { id: 0, name: "", points: 0 },
	};
};

/**
 * Single-entry requests delegate to the batch engine used by tournament
 * calculations so scoring, auto-sub, DGW and transfer rules have one source.
 */
export const entryLiveCalcService = {
	async calcLivePointsByEntry(
		context: GraphQLContext,
		eventId: number,
		entryId: number,
		includeLive = true
	): Promise<LiveCalcData> {
		if (
			!Number.isSafeInteger(eventId) ||
			!Number.isSafeInteger(entryId) ||
			eventId <= 0 ||
			entryId <= 0
		) {
			return buildNoPicksLiveCalcData(entryId);
		}

		const stopPicks = context.requestTiming?.start("entryLive.picks");
		const pickEntity = await entryLiveRepository
			.getEntryEventPick(context, entryId, eventId)
			.finally(() => stopPicks?.());
		if (!pickEntity || pickEntity.picks.length === 0) {
			const [entry, previousResult] = await Promise.all([
				entriesService.getEntryById(context, entryId).catch((error) => {
					context.logger?.warn(
						{ err: error, entryId, eventId },
						"Entry metadata unavailable for no-picks response"
					);
					return null;
				}),
				eventId > 1
					? entriesService.getEntryEventResult(context, entryId, eventId - 1)
					: Promise.resolve(null),
			]);
			return buildNoPicksLiveCalcData(entryId, eventId, entry, previousResult);
		}

		const calculate = async (): Promise<LiveCalcData> => {
			const { entryLiveBatchService } = await import("./batch-service");
			const stopAggregate = context.requestTiming?.start("entryLive.aggregate");
			const batch = await entryLiveBatchService
				.calcLivePointsForEntries(context, eventId, [entryId], includeLive, {
					picksByEntry: Promise.resolve(new Map([[entryId, pickEntity]])),
				})
				.finally(() => stopAggregate?.());
			const result = batch.results.get(entryId);
			if (result) {
				return {
					...result,
					availability: "READY",
				};
			}
			const message = batch.errors.find((error) => error.entryId === entryId)?.message;
			throw new Error(message ?? `Live points calculation failed for entry ${entryId}`);
		};

		return calculate();
	},
};
