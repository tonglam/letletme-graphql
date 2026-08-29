import type { Entry, EntryEventResult } from "../entries/repository";
import { hasCompleteEntryEventPick, type EntryEventPick } from "../entry-live/repository";
import {
	managerScoreHeartbeatFreshnessDeadline,
	isManagerScoreLiveHeartbeatFresh,
	unavailableManagerScore,
	type LiveManagerScore,
} from "../entry-live/manager-score";
import { parseFullFieldLiveBoardEnabled } from "../../infra/env-value";
import type { ManagerLiveScoreRow, ManagerLiveSource } from "../../infra/manager-live-client";
import type { Player } from "../players/repository";
import {
	entryLiveCompetitionBoardRevision,
	type CachedEntryLiveCompetitionBoard,
	type IndexedEntryLiveCompetitionBoardRow,
} from "./entry-live-competition-board";

/**
 * The lightweight full-field index is the normal paginated-board path. Keep an
 * explicit kill switch for incident mitigation, but do not silently fall back
 * to calculating every manager when the deployment omits the rollout flag.
 */
export const fullFieldLiveBoardEnabled = (value: string | undefined): boolean => {
	return parseFullFieldLiveBoardEnabled(value);
};

const canonicalChip = (raw: string | null): string => {
	const value = (raw ?? "")
		.trim()
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, "");
	if (value === "BENCHBOOST" || value === "BBOOST" || value === "BB") return "BENCH_BOOST";
	if (value === "TRIPLECAPTAIN" || value === "3XC" || value === "TC") return "TRIPLE_CAPTAIN";
	if (value === "FREEHIT" || value === "FH") return "FREE_HIT";
	if (value === "WILDCARD" || value === "WC") return "WILDCARD";
	if (value === "MANAGER" || value === "AM") return "MANAGER";
	return "NONE";
};

const isUsableMetric = (score: LiveManagerScore, requireNet: boolean): boolean =>
	requireNet
		? typeof score.netEventPoints === "number" && score.eventPointSemantics !== "UNKNOWN"
		: typeof score.eventPoints === "number";

const scoreFromDataRow = (
	row: ManagerLiveScoreRow | undefined,
	freshnessCheckedAt?: string | null
): LiveManagerScore => {
	if (!row) return unavailableManagerScore();
	const checkedAt = Date.parse(row.checkedAt);
	const fresh = freshnessCheckedAt
		? isManagerScoreLiveHeartbeatFresh(freshnessCheckedAt)
		: Number.isFinite(checkedAt) && Date.now() - checkedAt <= 30_000;
	const rankFresh =
		!freshnessCheckedAt || isManagerScoreLiveHeartbeatFresh(row.provenance.rankCheckedAt);
	const state = row.source === "FPL_FINAL_RESULT" ? "FINAL" : fresh ? "FRESH" : "STALE";
	return {
		eventPoints: row.eventPoints,
		netEventPoints: row.netEventPoints,
		totalPoints: row.totalPoints,
		totalScope: row.totalScope,
		eventRank: rankFresh ? row.eventRank : null,
		overallRank: rankFresh ? row.overallRank : null,
		leagueRank: rankFresh ? row.leagueRank : null,
		transferCost: row.transferCost ?? 0,
		source: row.source as ManagerLiveSource,
		state,
		eventPointSemantics: row.eventPointSemantics,
		revision: row.revision,
		checkedAt: row.checkedAt,
		upstreamUpdatedAt: row.upstreamUpdatedAt,
		staleAt:
			state === "FINAL" || !freshnessCheckedAt
				? row.staleAt
				: managerScoreHeartbeatFreshnessDeadline(freshnessCheckedAt),
		nextRefreshAt: null,
		reconciliation: "NOT_COMPARABLE",
		reasonCodes: [],
		calculationMode: row.calculationMode,
		algorithmVersion: row.algorithmVersion,
		provenance: row.provenance,
		effectiveLineup: row.effectiveLineup,
	};
};

const add = (counts: Map<number, number>, id: number): void => {
	if (!Number.isSafeInteger(id) || id <= 0) return;
	counts.set(id, (counts.get(id) ?? 0) + 1);
};

const pairs = (counts: Map<number, number>): [number, number][] =>
	Array.from(counts.entries()).sort((left, right) => left[0] - right[0]);

const scoreMetric = (score: LiveManagerScore, requireNet: boolean): number | null => {
	if (!isUsableMetric(score, requireNet)) return null;
	return requireNet ? score.netEventPoints : score.eventPoints;
};

const rankRows = (rows: IndexedEntryLiveCompetitionBoardRow[], requireNet: boolean): void => {
	const ranked = rows
		.map((row) => ({ row, metric: scoreMetric(row.score, requireNet) }))
		.filter(
			(item): item is { row: IndexedEntryLiveCompetitionBoardRow; metric: number } =>
				item.metric !== null
		)
		.sort((left, right) => right.metric - left.metric || left.row.entry - right.row.entry);
	let previousMetric: number | null = null;
	let previousRank = 0;
	for (let index = 0; index < ranked.length; index += 1) {
		const item = ranked[index]!;
		if (previousMetric === null || item.metric !== previousMetric) previousRank = index + 1;
		item.row.rank = previousRank;
		previousMetric = item.metric;
	}
};

export type FullFieldLiveBoardIndexInput = {
	season: string;
	eventId: number;
	tournamentId: number;
	coreRevision: string;
	playerRevision: string;
	managerRevision: string | null;
	rosterRevision: string;
	allEntryIds: readonly number[];
	entries: ReadonlyMap<number, Entry>;
	eventResults?: ReadonlyMap<
		number,
		Pick<EntryEventResult, "teamValue"> & Partial<Pick<EntryEventResult, "overallRank">>
	>;
	picks: ReadonlyMap<number, EntryEventPick>;
	players: ReadonlyMap<number, Player>;
	/** Event-scoped team ids; current player rows are only a name/value fallback. */
	playerTeamIds?: ReadonlyMap<number, number>;
	managerRows: ReadonlyMap<number, ManagerLiveScoreRow>;
	/** Current shared live heartbeat, after exact publication/revision fencing. */
	freshnessCheckedAt?: string | null;
	requireNet: boolean;
	/** Finalized FPL rows may legitimately have no captain boost. */
	allowFinalNoCaptainBoost?: boolean;
	/** TEAM_VALUE sorting must never turn an unknown value into zero. */
	requireTeamValue?: boolean;
	/** A finalized event must use its persisted event result, never current entry data. */
	requireEventTeamValue?: boolean;
};

/**
 * Build the full-field filter/rank index from Data manager rows and durable
 * roster metadata. This deliberately does not calculate live player points;
 * those are added only for the requested page and viewer by the resolver.
 */
export const buildFullFieldLiveBoardIndex = (
	input: FullFieldLiveBoardIndexInput
): CachedEntryLiveCompetitionBoard => {
	const rows: IndexedEntryLiveCompetitionBoardRow[] = [];
	for (const entryId of input.allEntryIds) {
		const entry = input.entries.get(entryId);
		if (!entry) throw new Error(`Entry ${entryId} has no entry metadata`);
		const pick = input.picks.get(entryId);
		if (!hasCompleteEntryEventPick(pick, input.eventId, entryId, input.allowFinalNoCaptainBoost)) {
			throw new Error(`Entry ${entryId} has no complete event pick row`);
		}
		const eventResult = input.eventResults?.get(entryId);
		const eventTeamValue = eventResult?.teamValue;
		const teamValue =
			typeof eventTeamValue === "number"
				? eventTeamValue
				: input.requireEventTeamValue
					? null
					: entry.teamValue;
		if (input.requireEventTeamValue && typeof eventTeamValue !== "number") {
			throw new Error(`Entry ${entryId} has no finalized event team value`);
		}
		if (input.requireTeamValue && typeof teamValue !== "number") {
			throw new Error(`Entry ${entryId} has no team value for TEAM_VALUE sorting`);
		}
		const ownerAny = new Set<number>();
		const ownerStarter = new Set<number>();
		const ownerBench = new Set<number>();
		const captains = new Set<number>();
		const viceCaptains = new Set<number>();
		const teamAny = new Map<number, number>();
		const teamStarter = new Map<number, number>();
		const teamBench = new Map<number, number>();
		for (const selected of pick?.picks ?? []) {
			const player = input.players.get(selected.element);
			if (!player) {
				throw new Error(`Entry ${entryId} pick ${selected.element} has no player metadata`);
			}
			const teamId = input.playerTeamIds
				? input.playerTeamIds.get(selected.element)
				: player.teamId;
			if (typeof teamId !== "number" || !Number.isSafeInteger(teamId) || teamId <= 0) {
				throw new Error(`Entry ${entryId} pick ${selected.element} has no team metadata`);
			}
			ownerAny.add(selected.element);
			add(teamAny, teamId);
			if (selected.position <= 11) {
				ownerStarter.add(selected.element);
				add(teamStarter, teamId);
			} else {
				ownerBench.add(selected.element);
				add(teamBench, teamId);
			}
			if (selected.isCaptain) captains.add(selected.element);
			if (selected.isViceCaptain) viceCaptains.add(selected.element);
		}
		const captain = (pick?.picks ?? []).find((selected) => selected.isCaptain);
		const managerRow = input.managerRows.get(entryId);
		const loadedScore = scoreFromDataRow(managerRow, input.freshnessCheckedAt);
		// Data may omit transferCost for a standings row even though the
		// event-scoped pick row has the official transfer cost. Keep the index's
		// ordering/filter value faithful to the pick contract in that case.
		const transferCost =
			typeof managerRow?.transferCost === "number" ? managerRow.transferCost : pick.transfersCost;
		const score =
			loadedScore.transferCost === transferCost ? loadedScore : { ...loadedScore, transferCost };
		rows.push({
			entry: entryId,
			entryName: entry.entryName,
			playerName: entry.playerName,
			rank: 0,
			// A shared live heartbeat only fences the immutable score inputs. Entry
			// metadata has no independently verified rank timestamp, so it must not
			// restore a rank that scoreFromDataRow deliberately suppressed as stale.
			overallRank:
				eventResult?.overallRank ??
				score.overallRank ??
				(input.freshnessCheckedAt ? 0 : (entry.overallRank ?? 0)),
			teamValue: typeof teamValue === "number" ? teamValue / 10 : 0,
			chip: canonicalChip(pick?.chip ?? null),
			livePoints: score.eventPoints ?? 0,
			transferCost,
			liveNetPoints: score.netEventPoints ?? score.eventPoints ?? 0,
			liveTotalPoints: score.totalPoints ?? 0,
			played: 0,
			toPlay: 0,
			captainId: captain?.element ?? 0,
			captainName: captain ? (input.players.get(captain.element)?.webName ?? "") : "",
			captainPoints: 0,
			score,
			searchText:
				`${entryId} ${entry?.entryName ?? ""} ${entry?.playerName ?? ""}`.toLocaleLowerCase(),
			ownerAny: [...ownerAny].sort((left, right) => left - right),
			ownerStarter: [...ownerStarter].sort((left, right) => left - right),
			ownerBench: [...ownerBench].sort((left, right) => left - right),
			captains: [...captains].sort((left, right) => left - right),
			viceCaptains: [...viceCaptains].sort((left, right) => left - right),
			teamAny: pairs(teamAny),
			teamStarter: pairs(teamStarter),
			teamBench: pairs(teamBench),
		});
	}

	rankRows(rows, input.requireNet);
	const officialRows = rows.filter((row) => isUsableMetric(row.score, input.requireNet));
	const unavailableEntryIds = rows
		.filter((row) => !isUsableMetric(row.score, input.requireNet))
		.map((row) => row.entry);
	const points = officialRows
		.map((row) => (input.requireNet ? row.score.netEventPoints : row.score.eventPoints))
		.filter((value): value is number => typeof value === "number");
	const failedEntryIds: number[] = [];
	const boardRevision = entryLiveCompetitionBoardRevision({
		season: input.season,
		eventId: input.eventId,
		tournamentId: input.tournamentId,
		coreRevision: input.coreRevision,
		playerRevision: input.playerRevision,
		managerRevision: input.managerRevision,
		rosterRevision: input.rosterRevision,
		windowRevision: input.rosterRevision,
		totalEntries: input.allEntryIds.length,
		unavailableEntryIds,
		failedEntryIds,
		rows,
	});
	return {
		boardRevision,
		playerRevision: input.playerRevision,
		managerRevision: input.managerRevision,
		rows,
		officialCoverage:
			input.allEntryIds.length === 0 ? 0 : officialRows.length / input.allEntryIds.length,
		unavailableEntryIds,
		partial: unavailableEntryIds.length > 0 || rows.length < input.allEntryIds.length,
		failedEntryIds,
		totalEntries: input.allEntryIds.length,
		highestEventPoints: points.length > 0 ? Math.max(...points) : null,
		averageEventPoints:
			points.length > 0 ? points.reduce((sum, value) => sum + value, 0) / points.length : null,
	};
};
