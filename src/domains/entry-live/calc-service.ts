import type { GraphQLContext } from "../../graphql/context";
import { enqueueEntryPicksSync } from "../../infra/entry-info-sync";
import type { Entry, EntryEventResult } from "../entries/repository";
import { entriesService } from "../entries/service";
import { eventsService } from "../events/service";
import type { LiveSnapshotMeta } from "../live/snapshot-meta";
import { resolvePreviousEventBaseline } from "./baseline";
import type { EntryEventTransfersData } from "./transfer-enrichment";
import { entryLiveRepository, hasCompleteEntryEventPick } from "./repository";
import { buildManagerScore, loadManagerScores, type LiveManagerScore } from "./manager-score";

export type EntryLiveAvailability = "READY" | "NO_PICKS";

export type ActiveCaptainData = {
	id: number;
	name: string;
	points: number;
};

export type LiveCalcData = {
	availability: EntryLiveAvailability;
	/** True while the board projects auto-subs/captaincy from revisioned live player totals. */
	provisional: boolean;
	snapshot: LiveSnapshotMeta | null;
	score: LiveManagerScore;
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
	/** Official transfer count when a finalized result is available without lineup detail. */
	eventTransfers?: number;
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
		provisional: false,
		snapshot: null,
		score: {
			eventPoints: null,
			netEventPoints: null,
			totalPoints: null,
			totalScope: "UNKNOWN",
			eventRank: null,
			overallRank: null,
			leagueRank: null,
			transferCost: 0,
			source: "UNAVAILABLE",
			state: "UNAVAILABLE",
			eventPointSemantics: "UNKNOWN",
			revision: null,
			checkedAt: null,
			upstreamUpdatedAt: null,
			staleAt: null,
			nextRefreshAt: null,
			reconciliation: "NO_LINEUP",
			reasonCodes: ["MISSING_LINEUP"],
		},
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
		teamValue: scaledEntryValue(entry?.teamValue),
		totalTransfers: entry?.totalTransfers ?? 0,
		lastOverallPoints: baseline.overallPoints,
		lastOverallRank: baseline.overallRank ?? 0,
		lastValue: scaledEntryValue(baseline.teamValue),
		chip: "NONE",
		livePoints: 0,
		transferCost: 0,
		liveNetPoints: 0,
		// Headline totals are official-manager-only; historical baseline belongs
		// exclusively to the lastOverallPoints display field.
		liveTotalPoints: 0,
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
		entryId: number
	): Promise<LiveCalcData> {
		if (
			!Number.isSafeInteger(eventId) ||
			!Number.isSafeInteger(entryId) ||
			eventId <= 0 ||
			entryId <= 0
		) {
			return buildNoPicksLiveCalcData(entryId);
		}

		const calculate = async (): Promise<LiveCalcData> => {
			const { entryLiveBatchService } = await import("./batch-service");
			const stopAggregate = context.requestTiming?.start("entryLive.aggregate");
			const batch = await entryLiveBatchService
				// Do not prefetch picks into the batch path. Once the event is
				// finalized, the batch service must be able to roll over to its
				// finalization-scoped cache and observe official multipliers,
				// automatic_subs, and captain changes.
				.calcLivePointsForEntries(context, eventId, [entryId])
				.finally(() => stopAggregate?.());
			const result = batch.results.get(entryId);
			if (result) return result;
			const message = batch.errors.find((error) => error.entryId === entryId)?.message;
			throw new Error(message ?? `Live points calculation failed for entry ${entryId}`);
		};

		const stopPicks = context.requestTiming?.start("entryLive.picks");
		const pickEntity = await entryLiveRepository
			.getEntryEventPick(context, entryId, eventId)
			.finally(() => stopPicks?.());
		// A normal live pick miss can race final publication. Delegate finalized
		// events to the batch path, which refreshes finalization-scoped picks and
		// retains the durable official result even if rich picks remain unavailable.
		if (!hasCompleteEntryEventPick(pickEntity, eventId, entryId)) {
			const event = await eventsService.getEventById(context, eventId).catch(() => null);
			if (event?.finished === true && event.dataChecked === true) {
				return calculate();
			}
		}
		if (!hasCompleteEntryEventPick(pickEntity, eventId, entryId)) {
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
			// Public live-points pages accept any valid FPL entry, while the Data
			// service normally fan-outs event picks for tournament rosters. Queue
			// this missing entry on demand so the next refresh can calculate the
			// player-level score instead of permanently returning NO_PICKS.
			enqueueEntryPicksSync(entryId, eventId);
			const noPicks = buildNoPicksLiveCalcData(entryId, eventId, entry, previousResult);
			const managerScores = await loadManagerScores(context, eventId, [entryId], undefined, {
				includeEffectiveLineup: true,
			});
			const manager = buildManagerScore({
				row: managerScores.rows.get(entryId),
				upstreamErrorCode: managerScores.errorCode,
				provisional: true,
				available: false,
				transferCost: 0,
				detailEventPoints: 0,
				nextRefreshAt: managerScores.nextRefreshAt,
			});
			return {
				...noPicks,
				provisional: true,
				score: manager.score,
				rank: manager.headline.rank,
				livePoints: manager.headline.livePoints,
				liveNetPoints: manager.headline.liveNetPoints,
				liveTotalPoints: manager.headline.liveTotalPoints,
			};
		}
		return calculate();
	},
};
