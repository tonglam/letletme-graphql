import { GraphQLError } from "graphql";
import { normalizeFplChip } from "../../contracts/fpl-chip";
import type { GraphQLContext } from "../../graphql/context";
import type { Player, Team } from "../../infra/types";
import type { Entry } from "../entries/repository";
import { entriesService } from "../entries/service";
import type { Fixture } from "../fixtures/repository";
import { fixturesService } from "../fixtures/service";
import type { LivePerformance, TargetedLiveRead } from "../live/repository";
import { liveRepository } from "../live/repository";
import { loadLiveSnapshotMeta, type LiveSnapshotReference } from "../live/snapshot-meta";
import { playersRepository } from "../players/repository";
import {
	type ActiveCaptainData,
	buildNoPicksLiveCalcData,
	type ElementEventResultData,
	type LiveCalcData,
} from "./calc-service";
import {
	MANAGER_LIVE_SCORE_BATCH_CONCURRENCY,
	loadManagerScoresInChunks,
	managerScoreLoadHasCoherentProvenance,
	splitManagerLiveEntryIds,
} from "./manager-score-batches";
import {
	buildManagerScore,
	loadManagerScores,
	unavailableManagerScore,
	type OfficialManagerScoreRow,
	type ManagerScoreLoad,
} from "./manager-score";
import { eventsService } from "../events/service";
import type { EntryEventPick, EntryEventTransferRow } from "./repository";
import {
	entryEventPickFromFinalResult,
	entryLiveRepository,
	hasCompleteEntryEventPick,
} from "./repository";
import { resolvePreviousEventBaseline } from "./baseline";
import type { EntryEventResult } from "../entries/repository";
import {
	buildTeamMapById,
	type EntryEventTransfersData,
	enrichTransferRows,
} from "./transfer-enrichment";
import type { EffectiveLineupRow } from "../../infra/manager-live-client";

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

export type EntryLiveBatchPrefetched = {
	entriesById?: ReadonlyMap<number, Entry>;
	liveByPlayer?: Promise<Map<number, LivePerformance>>;
	fixtures?: Promise<Fixture[]>;
	teams?: Promise<Team[]>;
	picksByEntry?: Promise<Map<number, EntryEventPick>>;
	tournamentId?: number;
	managerScores?: ManagerScoreLoad;
	managerReadMode?: "CACHE_ONLY" | "READ_THROUGH";
	liveRef?: LiveSnapshotReference;
	/**
	 * Normal board pages may intentionally use a complete durable last-good
	 * manager head while the live publication keeps advancing. Explicit
	 * revision requests never set this escape hatch.
	 */
	allowLastGoodManagerScores?: boolean;
};

const MAX_ENTRY_BATCH = 500;

/**
 * Data fixes one event-live publication for the whole manager-live request.
 * When GraphQL could not resolve the publication manifest before the request,
 * use the identity returned by Data and fence the player-detail read to the
 * same publication. A conflicting set of refs is a hard detail-read miss; it
 * is never converted into a synthetic publication identity.
 */
type DataLiveReferenceResolution = {
	reference: LiveSnapshotReference | null;
	conflict: boolean;
};

const dataLiveReferenceFromRows = (
	rows: ReadonlyMap<number, OfficialManagerScoreRow>
): DataLiveReferenceResolution => {
	let reference: LiveSnapshotReference | null = null;
	for (const row of rows.values()) {
		const provenance = row.provenance;
		if (!provenance?.livePublicationId || !provenance.liveRevision) continue;
		const next = {
			publicationId: provenance.livePublicationId,
			revision: provenance.liveRevision,
		};
		if (!reference) {
			reference = next;
			continue;
		}
		if (reference.publicationId !== next.publicationId || reference.revision !== next.revision) {
			return { reference: null, conflict: true };
		}
	}
	return { reference, conflict: false };
};

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

type ChunkedEntryLiveBatchPrefetched = Omit<
	EntryLiveBatchPrefetched,
	"liveByPlayer" | "fixtures" | "teams" | "picksByEntry"
>;

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

const hasCompleteLineupMembership = (
	picks: readonly { element: number }[],
	authorityLineup: readonly EffectiveLineupRow[]
): boolean => {
	if (picks.length !== authorityLineup.length) return false;
	const pickElements = new Set(picks.map((pick) => pick.element));
	const authorityElements = new Set(authorityLineup.map((row) => row.elementId));
	return (
		pickElements.size === picks.length &&
		authorityElements.size === authorityLineup.length &&
		pickElements.size === authorityElements.size &&
		[...pickElements].every((elementId) => authorityElements.has(elementId))
	);
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
	// Full-time is published as `finishedProvisional` before the later
	// data-checked `finished` flag. Auto-sub projections should start at full-time,
	// while every fixture in a DGW must still be complete.
	const fixtureIsComplete = (fixture: Fixture): boolean =>
		fixture.finished === true || fixture.finishedProvisional === true;
	const anyStarted = fixtures.some(
		(fixture) => fixture.started === true || fixtureIsComplete(fixture)
	);
	const anyFinished = fixtures.some(fixtureIsComplete);
	const allFinished = fixtures.every(fixtureIsComplete);

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

export const normalizeChip = (raw: string | null | undefined): string =>
	normalizeFplChip(raw, "NONE") ?? "NONE";

const computeSingleEntry = (
	entryId: number,
	eventId: number,
	perEntry: PerEntryData,
	shared: SharedData,
	provisional: boolean,
	authorityLineup: readonly EffectiveLineupRow[]
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

	const baseline = resolvePreviousEventBaseline(entry, eventId, previousResult);
	const lastOverallPoints = baseline.overallPoints;
	const lastOverallRank = baseline.overallRank ?? 0;
	const lastValue = asScaled(baseline.teamValue, 10);
	const transfersList: EntryEventTransfersData[] = enrichTransferRows({
		entryId,
		eventId,
		transferRows,
		playersById,
		teamsById,
		liveByPlayer,
	});

	const authorityByElement = new Map(authorityLineup.map((row) => [row.elementId, row] as const));
	const hasCompleteAuthorityLineup = hasCompleteLineupMembership(pickList, authorityLineup);
	if (!hasCompleteAuthorityLineup) {
		return {
			availability: "LINEUP_UNAVAILABLE",
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
			livePoints: 0,
			transferCost,
			liveNetPoints: 0,
			liveTotalPoints: 0,
			played: 0,
			toPlay: 0,
			playedCaptain: 0,
			captainName: "",
			pickList: [],
			transfersList,
			activeCaptain: { id: 0, name: "", points: 0 },
		};
	}
	for (const pick of pickList) {
		const row = authorityByElement.get(pick.element)!;
		pick.multiplier = row.effectiveMultiplier;
		pick.pickActive = row.pickActive;
		pick.autoSub = row.autoSub;
		pick.position = row.position;
		pick.isCaptain = row.isCaptain;
		pick.isViceCaptain = row.isViceCaptain;
	}
	const activePicks = pickList.filter((pick) => pick.pickActive);
	const captainForScoring =
		pickList.find((pick) => authorityByElement.get(pick.element)?.captainForScoring) ?? null;
	const livePoints = activePicks.reduce((sum, pick) => sum + pick.totalPoints * pick.multiplier, 0);

	const liveNetPoints = livePoints - transferCost;
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

	return {
		availability: "READY",
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
		prefetched?: EntryLiveBatchPrefetched
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

		// Phase 1: resolve identity, picks, and the authoritative manager score in
		// parallel. When the caller has no publication fence, Data fixes one for the
		// request and returns it with the score. Waiting for GraphQL's independent
		// manifest read here would recreate the slow serial preflight this batch is
		// designed to avoid.
		const loadedLiveMetaPromise = loadLiveSnapshotMeta(context, eventId).catch(() => null);
		const loadAuthoritativeManagerScores = async (
			liveRef: LiveSnapshotReference | undefined
		): Promise<ManagerScoreLoad> => {
			const stopManagerScores = context.requestTiming?.start("entryLive.managerScores");
			try {
				return await loadManagerScores(context, eventId, entryIds, prefetched?.tournamentId, {
					includeEffectiveLineup: true,
					readMode: prefetched?.managerReadMode,
					...(liveRef?.publicationId
						? {
								liveRef: {
									publicationId: liveRef.publicationId,
									revision: liveRef.revision,
								},
							}
						: {}),
				});
			} finally {
				stopManagerScores?.();
			}
		};
		const eagerManagerScoresPromise = prefetched?.managerScores
			? null
			: loadAuthoritativeManagerScores(prefetched?.liveRef);
		const stopPhaseOne = context.requestTiming?.start("entryLive.phase1");
		const [
			entriesById,
			picksByEntry,
			previousResultsByEntry,
			event,
			loadedLiveMeta,
			eagerManagerScores,
		] = await Promise.all([
			prefetched?.entriesById ?? entriesService.getEntriesByIds(context, entryIds),
			prefetched?.picksByEntry ??
				entryLiveRepository.getEntryEventPicksByIds(context, entryIds, eventId),
			eventId > 1
				? entriesService.getEntryEventResultsByEntryIds(context, entryIds, eventId - 1)
				: Promise.resolve(new Map<number, EntryEventResult>()),
			eventsService.getEventById(context, eventId).catch(() => null),
			loadedLiveMetaPromise,
			eagerManagerScoresPromise,
		]).finally(() => stopPhaseOne?.());
		const pinnedLiveMeta = prefetched?.liveRef ?? loadedLiveMeta;
		const provisional = !(event?.finished === true && event.dataChecked === true);
		const prefetchedManagerScores = prefetched?.managerScores;
		const canUseLastGoodManagerScores =
			prefetched?.allowLastGoodManagerScores === true &&
			prefetchedManagerScores?.dataAvailability === "LAST_GOOD" &&
			prefetchedManagerScores.errorCode === null &&
			prefetchedManagerScores.missingEntryIds.length === 0;
		const prefetchedManagerScoresAreUsable =
			prefetchedManagerScores !== undefined &&
			entryIds.every((entryId) => {
				const row = prefetchedManagerScores.rows.get(entryId);
				if (!row?.effectiveLineup || row.effectiveLineup.length !== 15) return false;
				if (!provisional || !pinnedLiveMeta?.publicationId) return true;
				if (canUseLastGoodManagerScores) return true;
				return (
					row.provenance?.livePublicationId === pinnedLiveMeta.publicationId &&
					row.provenance.liveRevision === pinnedLiveMeta.revision
				);
			});
		const managerScores = prefetchedManagerScoresAreUsable
			? prefetchedManagerScores
			: (eagerManagerScores ?? (await loadAuthoritativeManagerScores(pinnedLiveMeta ?? undefined)));
		const dataLiveReference = dataLiveReferenceFromRows(managerScores.rows);
		// An explicit caller fence wins. Otherwise use the exact publication fixed
		// by Data for the manager score, falling back to GraphQL's manifest only when
		// the manager response has no publication identity. Headline and detail must
		// always stay on one revision.
		const detailLiveReference = provisional
			? (prefetched?.liveRef ?? dataLiveReference.reference ?? loadedLiveMeta)
			: null;
		const fullSnapshotMeta =
			loadedLiveMeta &&
			(!provisional ||
				(detailLiveReference !== null &&
					loadedLiveMeta.publicationId === detailLiveReference.publicationId &&
					loadedLiveMeta.revision === detailLiveReference.revision))
				? loadedLiveMeta
				: null;
		const managerFreshnessCheckedAt =
			provisional &&
			fullSnapshotMeta?.publicationId &&
			dataLiveReference.reference?.publicationId === fullSnapshotMeta.publicationId &&
			dataLiveReference.reference.revision === fullSnapshotMeta.revision
				? fullSnapshotMeta.checkedAt
				: null;
		const detailReferenceUnavailable =
			provisional &&
			(dataLiveReference.conflict || detailLiveReference === null || canUseLastGoodManagerScores);
		// Manager headline availability is independent from lineup availability.
		// Keep NO_PICKS metadata cheap while still resolving the official manager
		// score; final lifecycle evidence requires a persisted lineup/result pair.
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
			// A final result is usable only when its rich publication is at or after
			// FPL's data_checked_at fence. Historical/backfilled events may carry the
			// accepted `dataChecked=true` flag without a timestamp; in that case the
			// rich result's own checked timestamp is the only available final-result
			// freshness signal, so retain it instead of silently discarding canonical
			// result picks.
			const finalFreshAfter = event?.dataCheckedAt ? Date.parse(event.dataCheckedAt) : null;
			const freshFinalizedResults = new Map(
				[...finalizedResults].filter(([, result]) => {
					const richSyncedAt = Date.parse(result.richSyncedAt);
					return (
						Number.isFinite(richSyncedAt) &&
						(finalFreshAfter === null ||
							(!Number.isNaN(finalFreshAfter) && richSyncedAt >= finalFreshAfter))
					);
				})
			);
			finalizedResultsByEntry = freshFinalizedResults;
			const durableEntryIds = entryIds.filter((entryId) => freshFinalizedResults.has(entryId));
			const settlingEntryIds = entryIds.filter((entryId) => !freshFinalizedResults.has(entryId));
			const durableResults = durableEntryIds
				.map((entryId) => freshFinalizedResults.get(entryId))
				.filter((result): result is EntryEventResult => result !== undefined);
			const [durablePicks, settlingPicks] = await Promise.all([
				Promise.resolve(
					new Map(
						durableResults.flatMap((result) => {
							const pick = entryEventPickFromFinalResult(result);
							return [[result.entryId, pick] as const];
						})
					)
				),
				settlingEntryIds.length > 0
					? entryLiveRepository.getEntryEventPicksByIds(context, settlingEntryIds, eventId, true)
					: Promise.resolve(new Map<number, EntryEventPick>()),
			]);
			for (const [entryId, pick] of [...durablePicks, ...settlingPicks]) {
				picksByEntry.set(entryId, pick);
			}
		}
		const readyEntryIds = entryIds.filter((entryId) =>
			hasCompleteEntryEventPick(picksByEntry.get(entryId), eventId, entryId, !provisional)
		);
		const readyEntryIdSet = new Set(readyEntryIds);
		const results = new Map<number, LiveCalcData>();
		for (const entryId of entryIds) {
			if (!readyEntryIdSet.has(entryId)) {
				const entry = entriesById.get(entryId) ?? null;
				const previousResult = previousResultsByEntry.get(entryId) ?? null;
				const finalized = finalizedResultsByEntry.get(entryId);
				const authoritativeRow = managerScores.rows.get(entryId);
				const noPicks = buildNoPicksLiveCalcData(entryId, eventId, entry, previousResult);
				const manager = buildManagerScore({
					row: authoritativeRow,
					upstreamErrorCode: managerScores.errorCode,
					provisional,
					available: false,
					transferCost: finalized?.eventTransfersCost ?? 0,
					detailEventPoints: finalized?.eventPoints ?? 0,
					nextRefreshAt: managerScores.nextRefreshAt,
					freshnessCheckedAt: managerFreshnessCheckedAt,
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
					overallRank: manager.score.overallRank ?? noPicks.overallRank,
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
		// for detail rows. The headline remains the Data final-result row after the
		// event is data_checked.
		// A caller may omit the heavy display detail, but every active score still
		// requires the coherent event-live payload. Detail reads never switch the
		// manager headline to another scoring source.
		const needsLiveDetails = readyEntryIds.length > 0;
		const useTargetedLiveRead =
			needsLiveDetails && readyEntryIds.length === 1 && prefetched?.liveByPlayer === undefined;
		const [liveByPlayerRaw, fixtures, teams, transfersByEntry] = await Promise.all([
			detailReferenceUnavailable
				? Promise.resolve(new Map<number, LivePerformance>())
				: (prefetched?.liveByPlayer ??
					(needsLiveDetails && !useTargetedLiveRead
						? liveRepository.getAllLivePerformances(context, eventId, detailLiveReference)
						: Promise.resolve(new Map<number, LivePerformance>()))),
			prefetched?.fixtures ?? fixturesService.getEventFixtures(context, eventId),
			prefetched?.teams ?? playersRepository.listTeams(context),
			entryLiveRepository.getEntryEventTransfersByIds(context, readyEntryIds, eventId),
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
			// During the live phase the detail read must be pinned to the same
			// publication as the headline. Once the event is settled there is no
			// live ref to pin: use the repository's unpinned targeted read, which
			// selects the durable final player rows when the live publication is
			// gone. Never turn a missing provisional ref into an unpinned read.
			if (detailReferenceUnavailable) return null;
			const stopSnapshot = context.requestTiming?.start("entryLive.liveSnapshot");
			try {
				return await liveRepository.getTargetedLiveRead(
					context,
					eventId,
					playerIds,
					detailLiveReference ?? null
				);
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
				if (targetedLiveError) {
					throw targetedLiveError;
				}
				const perEntry: PerEntryData = {
					entryId,
					entry: entriesById.get(entryId) ?? null,
					pickEntity: picksByEntry.get(entryId) ?? null,
					transferRows: transfersByEntry.get(entryId) ?? [],
					previousResult: previousResultsByEntry.get(entryId) ?? null,
				};
				const authorityLineup = managerScores.rows.get(entryId)?.effectiveLineup ?? [];

				const calcData = {
					...computeSingleEntry(entryId, eventId, perEntry, shared, provisional, authorityLineup),
					snapshot: targetedLive?.meta ?? fullSnapshotMeta,
				};
				const pickRows = perEntry.pickEntity?.picks ?? [];
				const detailHasAllLiveRows = pickRows.every((pick) => liveByPlayerMap.has(pick.element));
				// A pinned publication mismatch is represented as an empty live map by
				// the repository. Require every pick to have a row so a failed fence
				// cannot be mistaken for a valid zero-point detail payload. The lineup
				// membership check also prevents a same-length but different effective
				// lineup from being treated as a complete detail payload.
				const detailAvailable =
					!targetedLiveError &&
					detailHasAllLiveRows &&
					hasCompleteLineupMembership(pickRows, authorityLineup);
				const finalized = finalizedResultsByEntry.get(entryId);
				const authoritativeRow = managerScores.rows.get(entryId);
				const manager = buildManagerScore({
					row: authoritativeRow,
					upstreamErrorCode: managerScores.errorCode,
					provisional,
					available: detailAvailable,
					transferCost: calcData.transferCost,
					detailEventPoints: calcData.livePoints,
					nextRefreshAt: managerScores.nextRefreshAt,
					freshnessCheckedAt: managerFreshnessCheckedAt,
				});
				// Never compose a player detail payload from a revision that failed to
				// reconcile with the authoritative headline.
				const detailFailedClosed =
					manager.score.reconciliation === "SOURCE_SKEW" ||
					manager.score.reconciliation === "NO_LINEUP";
				results.set(entryId, {
					...calcData,
					...(detailFailedClosed
						? {
								availability: "LINEUP_UNAVAILABLE" as const,
								pickList: [],
								activeCaptain: { id: 0, name: "", points: 0 },
								snapshot: null,
								played: 0,
								toPlay: 0,
								playedCaptain: 0,
								captainName: "",
							}
						: {}),
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

/**
 * Calculate a whole tournament without violating the 500-entry upstream
 * contract. Chunks are deliberately limited to the manager-live client
 * concurrency so a large detail page cannot recreate the connection pressure
 * that caused the original incident. The caller receives one deterministic
 * result map and can rank it once across the complete cohort.
 */
export const calcLivePointsForEntriesInChunks = async (
	context: GraphQLContext,
	eventId: number,
	entryIds: readonly number[],
	prefetched?: ChunkedEntryLiveBatchPrefetched
): Promise<BatchLiveCalcResult> => {
	if (entryIds.length === 0) {
		return {
			results: new Map(),
			errors: [],
			meta: { eventId, totalEntries: 0, succeededCount: 0, failedCount: 0 },
		};
	}
	if (new Set(entryIds).size !== entryIds.length) {
		throw new GraphQLError("Entry batch must not contain duplicate entry IDs", {
			extensions: { code: "DUPLICATE_ENTRY_IDS" },
		});
	}

	const managerScores =
		prefetched?.managerScores ??
		(await loadManagerScoresInChunks(entryIds, (chunk) =>
			loadManagerScores(context, eventId, chunk, prefetched?.tournamentId, {
				includeEffectiveLineup: true,
				readMode: prefetched?.managerReadMode,
				...(prefetched?.liveRef?.publicationId
					? {
							liveRef: {
								publicationId: prefetched.liveRef.publicationId,
								revision: prefetched.liveRef.revision,
							},
						}
					: {}),
			})
		));
	if (!managerScoreLoadHasCoherentProvenance(managerScores, entryIds)) {
		return {
			results: new Map(),
			errors: entryIds.map((entryId) => ({
				entryId,
				message: "Manager score revisions are inconsistent for this cohort",
			})),
			meta: {
				eventId,
				totalEntries: entryIds.length,
				succeededCount: 0,
				failedCount: entryIds.length,
			},
		};
	}

	const liveReferences = new Set(
		[...managerScores.rows.values()].map((row) => {
			const publicationId = row.provenance?.livePublicationId;
			const revision = row.provenance?.liveRevision;
			return publicationId && revision ? `${publicationId}:${revision}` : null;
		})
	);
	const currentLiveMeta = prefetched?.liveRef
		? null
		: await loadLiveSnapshotMeta(context, eventId).catch(() => null);
	const singleManagerReference =
		liveReferences.size === 1 && !liveReferences.has(null)
			? (() => {
					const [value] = [...liveReferences] as string[];
					const separator = value.lastIndexOf(":");
					return separator > 0
						? { publicationId: value.slice(0, separator), revision: value.slice(separator + 1) }
						: null;
				})()
			: null;
	const rowsAlignedWithCurrentLive =
		prefetched?.liveRef !== undefined ||
		(currentLiveMeta !== null &&
			singleManagerReference !== null &&
			singleManagerReference.publicationId === currentLiveMeta.publicationId &&
			singleManagerReference.revision === currentLiveMeta.revision);
	const allowLastGoodManagerScores =
		prefetched?.allowLastGoodManagerScores === true ||
		(!rowsAlignedWithCurrentLive &&
			managerScores.dataAvailability !== "PARTIAL" &&
			managerScores.dataAvailability !== "UNAVAILABLE");
	const managerScoresForChunks =
		allowLastGoodManagerScores && managerScores.dataAvailability === "FRESH"
			? { ...managerScores, dataAvailability: "LAST_GOOD" as const }
			: managerScores;
	const chunkPrefetched: EntryLiveBatchPrefetched = {
		...prefetched,
		managerScores: managerScoresForChunks,
		allowLastGoodManagerScores,
		...(prefetched?.liveRef === undefined && rowsAlignedWithCurrentLive && singleManagerReference
			? { liveRef: singleManagerReference }
			: {}),
	};

	const chunks = splitManagerLiveEntryIds(entryIds);
	const results = new Map<number, LiveCalcData>();
	const errors: Array<{ entryId: number; message: string }> = [];
	for (let offset = 0; offset < chunks.length; offset += MANAGER_LIVE_SCORE_BATCH_CONCURRENCY) {
		const loaded = await Promise.all(
			chunks
				.slice(offset, offset + MANAGER_LIVE_SCORE_BATCH_CONCURRENCY)
				.map((chunk) =>
					entryLiveBatchService.calcLivePointsForEntries(context, eventId, chunk, chunkPrefetched)
				)
		);
		for (const batch of loaded) {
			for (const [entryId, row] of batch.results) results.set(entryId, row);
			errors.push(...batch.errors);
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
};
