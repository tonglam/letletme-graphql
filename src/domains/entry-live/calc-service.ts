import type { GraphQLContext } from "../../graphql/context";
import { enqueueEntryPicksSync } from "../../infra/entry-info-sync";
import type { Entry, EntryEventResult } from "../entries/repository";
import type { LiveSnapshotMeta } from "../live/snapshot-meta";
import { resolvePreviousEventBaseline } from "./baseline";
import type { EntryEventTransfersData } from "./transfer-enrichment";
import type { LiveManagerScore } from "./manager-score";

export type EntryLiveAvailability = "READY" | "NO_PICKS" | "LINEUP_UNAVAILABLE";

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

		// The batch engine is the canonical owner of picks, lifecycle rollover,
		// manager-score provenance and player-detail reconciliation. Calling it
		// once avoids the former single-entry preflight reading the same pick row a
		// second time, while preserving its finalized-picks refresh semantics.
		const { entryLiveBatchService } = await import("./batch-service");
		const stopAggregate = context.requestTiming?.start("entryLive.aggregate");
		const batch = await entryLiveBatchService
			.calcLivePointsForEntries(context, eventId, [entryId], {
				// Interactive reads must not spend the Web request deadline chasing a
				// moving live revision. Data returns the durable last-good head and
				// queues bounded recovery when that head genuinely needs refreshing.
				managerReadMode: "CACHE_ONLY",
			})
			.finally(() => stopAggregate?.());
		const result = batch.results.get(entryId);
		if (result) {
			// Public live-points pages accept any valid FPL entry. Queue only a true
			// durable pick miss; a revision-skewed LINEUP_UNAVAILABLE response must
			// wait for its canonical publication instead of launching a redundant sync.
			if (result.availability === "NO_PICKS") {
				enqueueEntryPicksSync(entryId, eventId, {
					logger: context.logger,
					requestId: context.requestId,
				});
			}
			return result;
		}
		const message = batch.errors.find((error) => error.entryId === entryId)?.message;
		throw new Error(message ?? `Live points calculation failed for entry ${entryId}`);
	},
};
