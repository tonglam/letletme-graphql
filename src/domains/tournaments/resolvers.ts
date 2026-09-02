import { createHash } from "node:crypto";
import { GraphQLError } from "graphql";
import type { GraphQLContext } from "../../graphql/context";
import type { Entry } from "../../contracts/entry";
import type { Event } from "../events/repository";
import { eventsService } from "../events/service";
import { LeagueType } from "../leagues/repository";
import type { Player } from "../players/repository";
import { playersService } from "../players/service";
import {
	h2hLeagueDeliveryV2,
	h2hLeagueTimesV2,
	h2hPublicationMatchesGlobal,
	readH2HLeaguePublicationV2,
	readH2HLeagueMembershipV2,
	type H2HLeaguePublicationReadV2,
	type H2HMatchPayloadV2,
	type H2HMatchSideV2,
	type H2HStandingsPayloadV2,
} from "../live-desks/h2h-v2";
import { assertLiveTournamentAccessV2 } from "../live-desks/access-v2";
import { liveDeliveryFreshnessStateV2 } from "../live-desks/league-v2";
import {
	LIVE_POINTS_ALGORITHM_VERSION,
	projectLivePointsFromPublishedEntryV2,
	readLivePublicationByRefV2,
	type LivePublicationReadV2,
} from "../entry-live/v2-service";
import { viewerEntryIdForPrincipal } from "../../graphql/authorization";

const MAX_H2H_PROJECTION_ENTRIES = 5_000;
const MAX_H2H_PROJECTION_MATCHES = 5_000;

/**
 * Per-request memoization for event lookups to avoid N+1 Redis round-trips
 * when resolving the `event` field on multiple TournamentEventResult rows.
 */
const eventMemo = new WeakMap<GraphQLContext, Map<number, Event | null>>();

const getEventByIdMemoized = async (
	context: GraphQLContext,
	eventId: number
): Promise<Event | null> => {
	let memo = eventMemo.get(context);
	if (!memo) {
		memo = new Map();
		eventMemo.set(context, memo);
	}
	const cached = memo.get(eventId);
	if (cached !== undefined) {
		return cached;
	}
	const event = await eventsService.getEventById(context, eventId);
	memo.set(eventId, event);
	return event;
};

const captainMemo = new WeakMap<GraphQLContext, Map<number, Player | null>>();

const getCaptainByIdMemoized = async (
	context: GraphQLContext,
	playerId: number
): Promise<Player | null> => {
	let memo = captainMemo.get(context);
	if (!memo) {
		memo = new Map();
		captainMemo.set(context, memo);
	}
	const cached = memo.get(playerId);
	if (cached !== undefined) {
		return cached;
	}
	const player = await playersService.getPlayerById(context, playerId);
	memo.set(playerId, player);
	return player;
};

import type {
	EntryH2HMatchResult,
	TournamentOfficialH2HHistory,
	TournamentBattleGroupResult,
	TournamentEntryRankingSummary,
	TournamentEventResult,
	TournamentInfo,
	TournamentMode,
	TournamentParticipant,
	TournamentSeasonSnapshot,
	TournamentSetupStatus,
	TournamentDetailDesk,
	ManagedTournamentStatus,
	TournamentSetupIssueDiagnostic,
	TournamentSetupWarningSummary,
	TournamentSetupWarningCategory,
	TournamentSetupIssueSeverity,
} from "./repository";
import {
	GroupMode,
	KnockoutMode,
	TournamentRosterMode,
	TournamentSetupPhase,
	TournamentState,
	TournamentSetupProgressMode,
} from "./repository";
import {
	assertTournamentInsightsReady,
	assertTournamentStandingsReady,
	tournamentsService,
} from "./service";
import { normalizeTournamentEventResultsPagination } from "./repository";
import { getTournamentSetupWarningSummaries } from "./repository";

const warningSummaryMemo = new WeakMap<
	GraphQLContext,
	Map<number, Promise<TournamentSetupWarningSummary[]>>
>();

const getTournamentSetupWarningSummariesMemoized = (
	context: GraphQLContext,
	tournamentId: number
): Promise<TournamentSetupWarningSummary[]> => {
	let memo = warningSummaryMemo.get(context);
	if (!memo) {
		memo = new Map();
		warningSummaryMemo.set(context, memo);
	}
	const cached = memo.get(tournamentId);
	if (cached) return cached;
	const request = getTournamentSetupWarningSummaries(context, tournamentId);
	memo.set(tournamentId, request);
	return request;
};

type EntryTournamentsArgs = {
	entryId: number;
};

type TournamentEntryIdsArgs = {
	tournamentId: number;
};

type TournamentMetadataArgs = {
	tournamentId: number;
	entryId: number;
};

type TournamentEventResultsArgs = {
	tournamentId: number;
	eventId: number;
	limit?: number | null;
	offset?: number | null;
};

type TournamentEntryRankingSummaryArgs = {
	tournamentId: number;
	eventId: number;
	entryId: number;
};

type TournamentSeasonSnapshotArgs = {
	tournamentId: number;
	eventId: number;
};

type TournamentBattleGroupResultsArgs = {
	tournamentId: number;
	eventId: number;
};

type EntryH2HMatchResultsArgs = {
	entryId: number;
};

type TournamentOfficialH2HArgs = {
	tournamentId: number;
	eventId: number;
};

type TournamentOfficialH2HHistoryArgs = {
	tournamentId: number;
	eventId: number;
	limit?: number | null;
};

export const leagueTypeToEnum = (type: LeagueType): string => {
	return type === LeagueType.H2H ? "H2H" : "CLASSIC";
};

export const tournamentModeToEnum = (_mode: TournamentMode): string => {
	return "NORMAL";
};

export const groupModeToEnum = (mode: GroupMode | null): string | null => {
	if (mode === null) {
		return null;
	}
	if (mode === GroupMode.POINTS_RACES) {
		return "POINTS_RACES";
	}
	if (mode === GroupMode.BATTLE_RACES) {
		return "BATTLE_RACES";
	}
	return "NO_GROUP";
};

export const knockoutModeToEnum = (mode: KnockoutMode | null): string | null => {
	if (mode === null) {
		return null;
	}
	if (mode === KnockoutMode.SINGLE_ELIMINATION) {
		return "SINGLE_ELIMINATION";
	}
	if (mode === KnockoutMode.DOUBLE_ELIMINATION) {
		return "DOUBLE_ELIMINATION";
	}
	if (mode === KnockoutMode.HEAD_TO_HEAD) {
		return "HEAD_TO_HEAD";
	}
	return "NO_KNOCKOUT";
};

export const tournamentStateToEnum = (state: TournamentState): string => {
	if (state === TournamentState.INACTIVE) {
		return "INACTIVE";
	}
	if (state === TournamentState.FINISHED) {
		return "FINISHED";
	}
	return "ACTIVE";
};

export const tournamentSetupStatusToEnum = (status: TournamentSetupStatus): string =>
	status.toUpperCase();

export const tournamentSetupPhaseToEnum = (phase: TournamentSetupPhase): string =>
	phase.toUpperCase();

export const tournamentSetupProgressModeToEnum = (mode: TournamentSetupProgressMode): string =>
	mode.toUpperCase();

export const tournamentSetupWarningCategoryToEnum = (
	category: TournamentSetupWarningCategory
): string => category.toUpperCase();

export const tournamentSetupIssueSeverityToEnum = (
	severity: TournamentSetupIssueSeverity
): string => severity.toUpperCase();

export const tournamentRosterModeToEnum = (mode: TournamentRosterMode): string =>
	mode.toUpperCase();

export const tournamentResultChipToEnum = (raw: string | null): string | null => {
	if (raw === null) {
		return null;
	}

	const value = raw.toUpperCase().trim();
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
	if (value === "FREE_HIT" || compactValue === "FREEHIT" || compactValue === "FH") {
		return "FREE_HIT";
	}
	if (value === "WILDCARD" || compactValue === "WILDCARD" || compactValue === "WC") {
		return "WILDCARD";
	}

	return null;
};

const h2hRevisionVector = (publication: H2HLeaguePublicationReadV2["publication"]) => ({
	publicationId: publication.publicationId,
	generation: publication.generation,
	roster: publication.revisions.roster,
	scoreCore: publication.revisions.scoreCore,
	fixtureIdentity: publication.revisions.fixtureIdentity,
	entryInputSet: publication.revisions.entryInputSet,
	identity: publication.revisions.identity,
	officialRank: publication.revisions.officialRank,
	rules: publication.revisions.rules,
	algorithm: publication.revisions.algorithm,
	content: publication.revisions.content,
});

const canonicalRevisionValue = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(canonicalRevisionValue).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalRevisionValue(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
};

const revisionHash = (value: unknown): string =>
	createHash("sha256").update(canonicalRevisionValue(value), "utf8").digest("hex");

const syntheticH2HEntry = (side: H2HMatchSideV2): Entry => ({
	id: side.entryId ?? 0,
	entryName: side.entryName,
	playerName: side.playerName ?? "",
	region: null,
	startedEvent: null,
	overallPoints: null,
	overallRank: null,
	bank: null,
	teamValue: null,
	totalTransfers: null,
	lastEventId: null,
	lastOverallPoints: null,
	lastOverallRank: null,
	lastTeamValue: null,
	lastBank: null,
});

const unavailableH2HSide = (side: H2HMatchSideV2, availability: string) => ({
	availability,
	entryId: side.entryId,
	entryName: side.entryName,
	playerName: side.playerName,
	isAverage: side.isAverage,
	points: null,
	netPoints: null,
});

const projectH2HSide = async (
	context: GraphQLContext,
	global: LivePublicationReadV2 | null,
	match: H2HMatchPayloadV2,
	side: H2HMatchSideV2
) => {
	if (match.state !== "READY") return unavailableH2HSide(side, match.state);
	if (match.isBye && side.entryId === null && !side.isAverage) {
		return {
			availability: "READY",
			entryId: null,
			entryName: side.entryName,
			playerName: side.playerName,
			isAverage: false,
			points: null,
			netPoints: null,
		};
	}
	if (side.entryId === null || side.isAverage) {
		return side.officialNetPoints === null
			? unavailableH2HSide(side, "PENDING")
			: {
					availability: "READY",
					entryId: side.entryId,
					entryName: side.entryName,
					playerName: side.playerName,
					isAverage: side.isAverage,
					points: side.officialNetPoints,
					netPoints: side.officialNetPoints,
				};
	}
	if (
		!global ||
		global.publication.publicationId !== match.globalRef.publicationId ||
		global.publication.generation !== match.globalRef.generation ||
		side.input === null
	)
		return unavailableH2HSide(side, "ERROR");
	try {
		const projected = await projectLivePointsFromPublishedEntryV2(
			context,
			global,
			side.input,
			{
				publicationId: side.inputPublicationId ?? match.globalRef.publicationId,
				generation: side.inputGeneration ?? match.globalRef.generation,
				sourceCheckedAt: side.inputContentUpdatedAt ?? match.sourceCheckedAt,
				servedFrom: global.servedFrom,
			},
			syntheticH2HEntry(side)
		);
		return {
			availability: "READY",
			entryId: side.entryId,
			entryName: side.entryName,
			playerName: side.playerName,
			isAverage: false,
			points: projected.score.eventPoints,
			netPoints: projected.score.netEventPoints,
			// Keep the projection source internal so the enclosing match can
			// expose the worst source across head, global, and both sides.
			servedFrom: projected.delivery.servedFrom,
		};
	} catch (error) {
		context.logger.warn(
			{ err: error, eventId: match.eventId, tournamentId: match.tournamentId },
			"H2H live side projection unavailable"
		);
		return unavailableH2HSide(side, "ERROR");
	}
};

const unavailableH2HDelivery = () => ({
	state: "UNAVAILABLE",
	servedFrom: "UNAVAILABLE",
	reasonCodes: ["PUBLICATION_UNAVAILABLE"],
});

const samePublicationRef = (
	left: { publicationId: string; generation: number },
	right: { publicationId: string; generation: number }
): boolean => left.publicationId === right.publicationId && left.generation === right.generation;

/**
 * Match rows may be retained independently of the H2H head. Their vector
 * must therefore describe the match and its exact global target instead of
 * copying the head vector for every match. Source timestamps stay out of the
 * content hashes; they are freshness evidence, not content.
 */
export const h2hMatchRevisionVectorV2 = (
	_headPublication: H2HLeaguePublicationReadV2["publication"],
	match: H2HMatchPayloadV2,
	global: LivePublicationReadV2 | null
) => {
	const target =
		global && samePublicationRef(global.publication, match.globalRef) ? global.publication : null;
	const targetRevision = (name: "scoreCore" | "fixtureIdentity" | "rules"): string =>
		target?.revisions[name].revision ??
		revisionHash({ unavailable: name, globalRef: match.globalRef });
	const sides = [match.home, match.away];
	const realSides = sides
		.filter((side) => side.entryId !== null && !side.isAverage)
		.map((side) => ({
			entryId: side.entryId,
			inputRevision: side.inputRevision,
			availability: side.input === null ? "PENDING" : "READY",
		}))
		.sort((left, right) => (left.entryId ?? 0) - (right.entryId ?? 0));
	const identity = {
		officialMatchId: match.officialMatchId,
		eventId: match.eventId,
		groupId: match.groupId,
		sourceOrder: match.sourceOrder,
		phase: match.phase,
		knockoutName: match.knockoutName,
		tiebreak: match.tiebreak,
		isBye: match.isBye,
		home: {
			entryId: match.home.entryId,
			entryName: match.home.entryName,
			isAverage: match.home.isAverage,
		},
		away: {
			entryId: match.away.entryId,
			entryName: match.away.entryName,
			isAverage: match.away.isAverage,
		},
	};
	const average = sides
		.filter((side) => side.isAverage)
		.map((side) => ({
			entryName: side.entryName,
			officialNetPoints: side.officialNetPoints,
		}))
		.sort((left, right) => left.entryName.localeCompare(right.entryName));
	const content = {
		identity,
		state: match.state,
		globalRef: match.globalRef,
		scoreCore: targetRevision("scoreCore"),
		algorithm: LIVE_POINTS_ALGORITHM_VERSION,
		sides: sides.map((side) => ({
			entryId: side.entryId,
			entryName: side.entryName,
			playerName: side.playerName,
			isAverage: side.isAverage,
			officialNetPoints: side.officialNetPoints,
			inputPublicationId: side.inputPublicationId,
			inputGeneration: side.inputGeneration,
			inputRevision: side.inputRevision,
		})),
	};
	return {
		publicationId: match.globalRef.publicationId,
		generation: match.globalRef.generation,
		roster: revisionHash(realSides.map(({ entryId }) => entryId)),
		scoreCore: targetRevision("scoreCore"),
		fixtureIdentity: targetRevision("fixtureIdentity"),
		entryInputSet: revisionHash(realSides),
		identity: revisionHash(identity),
		officialRank: null,
		rules: targetRevision("rules"),
		algorithm: LIVE_POINTS_ALGORITHM_VERSION,
		schedule: revisionHash({
			officialMatchId: match.officialMatchId,
			eventId: match.eventId,
			groupId: match.groupId,
			sourceOrder: match.sourceOrder,
			phase: match.phase,
			isBye: match.isBye,
		}),
		averageSide: average.length > 0 ? revisionHash(average) : null,
		content: revisionHash(content),
	};
};

const standingsGlobalIsValidated = async (
	context: GraphQLContext,
	eventId: number,
	read: H2HLeaguePublicationReadV2 | null
): Promise<boolean | undefined> => {
	const payload = read?.payload.standings as H2HStandingsPayloadV2 | undefined;
	if (!read || !payload || payload.state !== "READY" || read.publication.state !== "FINALIZED") {
		return undefined;
	}
	const global = await readLivePublicationByRefV2(
		context,
		eventId,
		read.publication.globalRef
	).catch(() => null);
	return global !== null && h2hPublicationMatchesGlobal(read.publication, global);
};

const deliverySourceRank = (source: string): number => {
	switch (source) {
		case "REDIS_CURRENT":
		case "FINAL_RESULT":
			return 0;
		case "REDIS_PREVIOUS":
			return 1;
		case "PROCESS_LKG":
			return 2;
		case "POSTGRES_CHECKPOINT":
			return 3;
		default:
			return 4;
	}
};

const worstDeliverySource = (sources: readonly string[]): string =>
	sources.reduce(
		(worst, source) => (deliverySourceRank(source) > deliverySourceRank(worst) ? source : worst),
		sources[0] ?? "UNAVAILABLE"
	);

const h2hMatchDelivery = (
	base: ReturnType<typeof h2hLeagueDeliveryV2>,
	global: LivePublicationReadV2 | null,
	sideSources: readonly string[] = []
) => {
	const globalSource = global?.servedFrom ?? "UNAVAILABLE";
	const servedFrom = worstDeliverySource([base.servedFrom, globalSource, ...sideSources]);
	const fallback = servedFrom !== "REDIS_CURRENT" && servedFrom !== "FINAL_RESULT";
	const reasonCodes = new Set(base.reasonCodes);
	if (!global) reasonCodes.add("MATCH_GLOBAL_UNAVAILABLE");
	else if (global.servedFrom !== "REDIS_CURRENT") reasonCodes.add("MATCH_GLOBAL_FALLBACK");
	if (sideSources.some((source) => source !== "REDIS_CURRENT" && source !== "FINAL_RESULT"))
		reasonCodes.add("MATCH_SIDE_FALLBACK");
	return {
		...base,
		state: fallback ? "DEGRADED" : base.state,
		servedFrom,
		reasonCodes: [...reasonCodes],
	};
};

export const officialH2HStandingsStateV2 = (
	read: H2HLeaguePublicationReadV2 | null,
	globalValidated?: boolean
): "READY" | "STALE" | "UPDATING" | "UNAVAILABLE" => {
	const payload = read?.payload.standings as H2HStandingsPayloadV2 | undefined;
	if (!read || !payload) return "UNAVAILABLE";
	if (payload.state === "UNAVAILABLE") return "UNAVAILABLE";
	if (payload.state === "UPDATING") return "UPDATING";
	if (read.publication.state !== "FINALIZED") return "UPDATING";
	if (globalValidated === false) return "UPDATING";
	return read.servedFrom === "REDIS_CURRENT" ? "READY" : "STALE";
};

type ProjectedH2HMatchV2 = {
	officialMatchId: number;
	eventId: number;
	groupId: number;
	sourceOrder: number;
	phase: H2HMatchPayloadV2["phase"];
	knockoutName: string | null;
	tiebreak: string | null;
	isBye: boolean;
	availability: "READY" | "PENDING" | "ERROR";
	delivery: ReturnType<typeof h2hMatchDelivery>;
	revisions: ReturnType<typeof h2hRevisionVector>;
	times: ReturnType<typeof h2hLeagueTimesV2>;
	home: Awaited<ReturnType<typeof projectH2HSide>>;
	away: Awaited<ReturnType<typeof projectH2HSide>>;
};

type ProjectedH2HStandingsV2 = {
	throughEventId: number;
	state: "READY" | "STALE" | "UPDATING" | "UNAVAILABLE";
	sourceCheckedAt: string;
	rows: H2HStandingsPayloadV2["rows"];
};

type TournamentOfficialH2HProjectionV2 = {
	eventId: number;
	availability: "READY";
	delivery: ReturnType<typeof h2hLeagueDeliveryV2>;
	revisions: ReturnType<typeof h2hRevisionVector>;
	times: ReturnType<typeof h2hLeagueTimesV2>;
	standings: ProjectedH2HStandingsV2 | null;
	matches: ProjectedH2HMatchV2[];
};

const H2H_MATCH_CADENCE_MS = 30_000;

const h2hMatchTimesV2 = (
	sourceCheckedAtValue: string,
	now: string,
	base: ReturnType<typeof h2hLeagueTimesV2>
): ReturnType<typeof h2hLeagueTimesV2> => {
	const sourceMs = Date.parse(sourceCheckedAtValue);
	const sourceCheckedAt = Number.isFinite(sourceMs) ? sourceCheckedAtValue : base.sourceCheckedAt;
	const sourceTime = Date.parse(sourceCheckedAt);
	const nextRefreshAt = Number.isFinite(sourceTime)
		? new Date(sourceTime + H2H_MATCH_CADENCE_MS).toISOString()
		: base.nextRefreshAt;
	const nextTime = nextRefreshAt === null ? Number.NaN : Date.parse(nextRefreshAt);
	const cadence =
		Number.isFinite(sourceTime) && Number.isFinite(nextTime)
			? Math.max(1_000, nextTime - sourceTime)
			: H2H_MATCH_CADENCE_MS;
	const staleAt = Number.isFinite(nextTime)
		? new Date(nextTime + Math.max(5_000, Math.min(30_000, cadence * 0.25))).toISOString()
		: base.staleAt;
	return {
		...base,
		sourceCheckedAt,
		contentUpdatedAt: sourceCheckedAt,
		servedAt: now,
		staleAt,
		nextRefreshAt,
	};
};

const h2hMatchFreshnessStateV2 = (
	times: ReturnType<typeof h2hLeagueTimesV2>,
	now: number,
	servedFrom: string,
	final: boolean
): "FRESH" | "STALE" | "DEGRADED" | "FINAL" => {
	if (final || servedFrom === "FINAL_RESULT") return "FINAL";
	if (servedFrom !== "REDIS_CURRENT") return "DEGRADED";
	return liveDeliveryFreshnessStateV2(times, now);
};

const H2H_PROJECTION_MAX_BYTES = 64 * 1024 * 1024;
const h2hProjectionCache = new Map<
	string,
	{ value: TournamentOfficialH2HProjectionV2; bytes: number }
>();
const h2hProjectionInFlight = new Map<string, Promise<TournamentOfficialH2HProjectionV2>>();
let h2hProjectionCacheBytes = 0;

const h2hProjectionKey = (
	context: GraphQLContext,
	tournamentId: number,
	eventId: number,
	head: H2HLeaguePublicationReadV2["publication"],
	standings: H2HLeaguePublicationReadV2["publication"] | null
): string =>
	[
		context.currentSeason.seasonCode,
		eventId,
		tournamentId,
		head.publicationId,
		head.generation,
		standings?.publicationId ?? "none",
		standings?.generation ?? "none",
	].join(":");

const rememberH2HProjection = (key: string, value: TournamentOfficialH2HProjectionV2): void => {
	const bytes = Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
	const existing = h2hProjectionCache.get(key);
	if (existing) h2hProjectionCacheBytes -= existing.bytes;
	h2hProjectionCache.delete(key);
	if (bytes > H2H_PROJECTION_MAX_BYTES) return;
	h2hProjectionCache.set(key, { value, bytes });
	h2hProjectionCacheBytes += bytes;
	while (h2hProjectionCacheBytes > H2H_PROJECTION_MAX_BYTES && h2hProjectionCache.size > 0) {
		const oldest = h2hProjectionCache.keys().next().value as string | undefined;
		if (oldest === undefined) break;
		const removed = h2hProjectionCache.get(oldest);
		h2hProjectionCache.delete(oldest);
		if (removed) h2hProjectionCacheBytes -= removed.bytes;
	}
};

const readH2HProjection = (key: string): TournamentOfficialH2HProjectionV2 | null => {
	const cached = h2hProjectionCache.get(key);
	if (!cached) return null;
	h2hProjectionCache.delete(key);
	h2hProjectionCache.set(key, cached);
	return cached.value;
};

const cacheableH2HProjection = (value: TournamentOfficialH2HProjectionV2): boolean =>
	value.matches.every(
		(match) => match.availability !== "ERROR" && match.delivery.servedFrom !== "UNAVAILABLE"
	);

const rebaseH2HProjection = (
	value: TournamentOfficialH2HProjectionV2,
	headRead: H2HLeaguePublicationReadV2,
	standingsRead: H2HLeaguePublicationReadV2 | null,
	standingsGlobalValidated?: boolean,
	projectionUsedProcessLkg = false
): TournamentOfficialH2HProjectionV2 => {
	const servedAt = new Date().toISOString();
	const currentTimes = h2hLeagueTimesV2(headRead.publication, servedAt);
	const servedFrom = projectionUsedProcessLkg ? "PROCESS_LKG" : headRead.servedFrom;
	const fallback = servedFrom !== "REDIS_CURRENT";
	const baseDelivery = h2hLeagueDeliveryV2(headRead);
	const delivery = {
		...baseDelivery,
		state: fallback ? "DEGRADED" : baseDelivery.state,
		servedFrom,
		reasonCodes: [
			...new Set([
				...baseDelivery.reasonCodes,
				...(projectionUsedProcessLkg ? ["PROJECTION_CACHE_FALLBACK"] : []),
			]),
		],
	};
	const matches = value.matches.map((match) => {
		const matchServedFrom = worstDeliverySource([
			match.delivery.servedFrom,
			headRead.servedFrom,
			...(projectionUsedProcessLkg ? ["PROCESS_LKG"] : []),
		]);
		const matchFallback = matchServedFrom !== "REDIS_CURRENT" && matchServedFrom !== "FINAL_RESULT";
		const times = h2hMatchTimesV2(match.times.sourceCheckedAt, servedAt, currentTimes);
		const deliveryState = h2hMatchFreshnessStateV2(
			times,
			Date.parse(servedAt),
			matchServedFrom,
			match.delivery.state === "FINAL"
		);
		return {
			...match,
			delivery: {
				...match.delivery,
				state: matchFallback ? "DEGRADED" : deliveryState,
				servedFrom: matchServedFrom,
				reasonCodes: [
					...new Set([
						...match.delivery.reasonCodes,
						...(matchFallback ? ["PROJECTION_CACHE_FALLBACK"] : []),
					]),
				],
			},
			times,
		};
	});
	return {
		...value,
		delivery,
		times: currentTimes,
		standings:
			value.standings && standingsRead
				? {
						...value.standings,
						state: officialH2HStandingsStateV2(standingsRead, standingsGlobalValidated),
					}
				: value.standings,
		matches,
	};
};

const readTournamentOfficialH2HV2 = async (
	context: GraphQLContext,
	tournamentId: number,
	eventId: number
) => {
	const viewerEntryId = context.principal ? viewerEntryIdForPrincipal(context.principal) : null;
	const membership = viewerEntryId
		? await readH2HLeagueMembershipV2(context, tournamentId, eventId, viewerEntryId)
		: null;
	await assertLiveTournamentAccessV2(context, tournamentId, viewerEntryId ?? 0, membership);
	const [headRead, initialStandingsRead] = await Promise.all([
		readH2HLeaguePublicationV2(context, tournamentId, eventId, "H2H_HEAD"),
		readH2HLeaguePublicationV2(context, tournamentId, eventId, "H2H_STANDINGS"),
	]);
	// Official standings are an independent publication. They may lag the
	// match head's global score reference while remaining valid retained
	// overlay data; requiring an exact head ref would reintroduce an
	// all-or-nothing gate for the H2H page.
	const standingsRead = initialStandingsRead;
	const standingsGlobalValidated = await standingsGlobalIsValidated(
		context,
		eventId,
		standingsRead
	);
	if (!headRead) {
		return {
			eventId,
			availability: "MISSING",
			delivery: unavailableH2HDelivery(),
			revisions: null,
			times: null,
			standings: standingsRead
				? {
						throughEventId: (standingsRead.payload.standings as H2HStandingsPayloadV2)
							.throughEventId,
						state: officialH2HStandingsStateV2(standingsRead, standingsGlobalValidated),
						sourceCheckedAt: (standingsRead.payload.standings as H2HStandingsPayloadV2)
							.sourceCheckedAt,
						rows: (standingsRead.payload.standings as H2HStandingsPayloadV2).rows,
					}
				: null,
			matches: [],
		};
	}
	const projectionKey = h2hProjectionKey(
		context,
		tournamentId,
		eventId,
		headRead.publication,
		standingsRead?.publication ?? null
	);
	const headGlobalRead = await readLivePublicationByRefV2(
		context,
		eventId,
		headRead.publication.globalRef
	).catch(() => null);
	const headGlobal =
		headGlobalRead && h2hPublicationMatchesGlobal(headRead.publication, headGlobalRead)
			? headGlobalRead
			: null;
	const cached = readH2HProjection(projectionKey);
	if (cached)
		return rebaseH2HProjection(
			cached,
			headRead,
			standingsRead,
			standingsGlobalValidated,
			headGlobal === null
		);
	const existing = h2hProjectionInFlight.get(projectionKey);
	if (existing)
		return rebaseH2HProjection(
			await existing,
			headRead,
			standingsRead,
			standingsGlobalValidated,
			headGlobal === null
		);
	const project = async (): Promise<TournamentOfficialH2HProjectionV2> => {
		const publication = headRead.publication;
		const global = headGlobal;
		const delivery = h2hLeagueDeliveryV2(headRead);
		const revisions = h2hRevisionVector(publication);
		const times = h2hLeagueTimesV2(publication);
		const globalByRef = new Map<string, Promise<LivePublicationReadV2 | null>>();
		if (global) {
			globalByRef.set(
				`${global.publication.publicationId}:${global.publication.generation}`,
				Promise.resolve(global)
			);
		}
		const globalForMatch = async (
			match: H2HMatchPayloadV2
		): Promise<LivePublicationReadV2 | null> => {
			const key = `${match.globalRef.publicationId}:${match.globalRef.generation}`;
			const existing = globalByRef.get(key);
			if (existing) return existing;
			if (samePublicationRef(match.globalRef, publication.globalRef)) return global;
			const load = readLivePublicationByRefV2(context, eventId, match.globalRef)
				.then((value) => value)
				.catch(() => null);
			globalByRef.set(key, load);
			return load;
		};
		const matchRows = headRead.index.flatMap((indexRow) => {
			if (!("matchId" in indexRow)) return [];
			const match = headRead.payload[String(indexRow.matchId)] as H2HMatchPayloadV2 | undefined;
			return match ? [{ indexRow, match }] : [];
		});
		const projectedEntryIds = new Set(
			matchRows.flatMap(({ match }) =>
				[match.home.entryId, match.away.entryId].filter(
					(entryId): entryId is number => entryId !== null
				)
			)
		);
		if (
			projectedEntryIds.size > MAX_H2H_PROJECTION_ENTRIES ||
			matchRows.length > MAX_H2H_PROJECTION_MATCHES
		)
			throw new GraphQLError("The live H2H publication is too large to project", {
				extensions: { code: "LIVE_H2H_TOO_LARGE" },
			});
		let matchCursor = 0;
		const matchResults: Array<ProjectedH2HMatchV2 | undefined> = Array.from(
			{ length: matchRows.length },
			() => undefined
		);
		const matchWorker = async (): Promise<void> => {
			for (;;) {
				const index = matchCursor++;
				if (index >= matchRows.length) return;
				const { match } = matchRows[index]!;
				const matchGlobal = await globalForMatch(match);
				const [home, away] = await Promise.all([
					projectH2HSide(context, matchGlobal, match, match.home),
					projectH2HSide(context, matchGlobal, match, match.away),
				]);
				const availability =
					match.state !== "READY"
						? match.state
						: home.availability === "ERROR" || away.availability === "ERROR"
							? "ERROR"
							: home.availability === "PENDING" || away.availability === "PENDING"
								? "PENDING"
								: "READY";
				const matchDelivery = h2hMatchDelivery(
					delivery,
					matchGlobal,
					[home, away].flatMap((side) =>
						"servedFrom" in side && typeof side.servedFrom === "string" ? [side.servedFrom] : []
					)
				);
				matchResults[index] = {
					officialMatchId: match.officialMatchId,
					eventId: match.eventId,
					groupId: match.groupId,
					sourceOrder: match.sourceOrder,
					phase: match.phase,
					knockoutName: match.knockoutName,
					tiebreak: match.tiebreak,
					isBye: match.isBye,
					availability,
					delivery:
						availability === "READY"
							? matchDelivery
							: {
									...matchDelivery,
									reasonCodes: [...matchDelivery.reasonCodes, "MATCH_PROJECTION_INCOMPLETE"],
								},
					revisions: h2hMatchRevisionVectorV2(publication, match, matchGlobal),
					times: {
						...times,
						sourceCheckedAt: match.sourceCheckedAt,
						contentUpdatedAt: match.sourceCheckedAt,
					},
					home,
					away,
				};
			}
		};
		await Promise.all(
			Array.from({ length: Math.min(16, Math.max(1, matchRows.length)) }, () => matchWorker())
		);
		const matches = matchResults.filter(
			(match): match is ProjectedH2HMatchV2 => match !== undefined
		);
		const standingsPayload = standingsRead?.payload.standings as H2HStandingsPayloadV2 | undefined;
		const standingsState = officialH2HStandingsStateV2(standingsRead, standingsGlobalValidated);
		return {
			eventId,
			availability: "READY",
			delivery,
			revisions,
			times,
			standings: standingsPayload
				? {
						throughEventId: standingsPayload.throughEventId,
						state: standingsState,
						sourceCheckedAt: standingsPayload.sourceCheckedAt,
						rows: standingsPayload.rows,
					}
				: null,
			matches,
		};
	};
	const load = project()
		.then((value) => {
			if (cacheableH2HProjection(value)) rememberH2HProjection(projectionKey, value);
			return value;
		})
		.finally(() => h2hProjectionInFlight.delete(projectionKey));
	h2hProjectionInFlight.set(projectionKey, load);
	return rebaseH2HProjection(await load, headRead, standingsRead, standingsGlobalValidated);
};

export const tournamentsResolvers = {
	Query: {
		entryParticipatingTournaments: async (
			_parent: unknown,
			args: EntryTournamentsArgs,
			context: GraphQLContext
		): Promise<TournamentInfo[]> =>
			tournamentsService.getEntryParticipatingTournaments(context, args.entryId),

		manageableTournaments: async (
			_parent: unknown,
			args: EntryTournamentsArgs,
			context: GraphQLContext
		): Promise<TournamentInfo[]> =>
			tournamentsService.getManageableTournaments(context, args.entryId),

		tournament: async (
			_parent: unknown,
			args: TournamentMetadataArgs,
			context: GraphQLContext
		): Promise<TournamentInfo | null> =>
			tournamentsService.getTournamentForMember(context, args.tournamentId, args.entryId),

		managedTournament: async (
			_parent: unknown,
			args: TournamentMetadataArgs,
			context: GraphQLContext
		): Promise<TournamentInfo | null> =>
			tournamentsService.getManagedTournament(context, args.tournamentId, args.entryId),

		tournamentParticipants: async (
			_parent: unknown,
			args: TournamentEntryIdsArgs,
			context: GraphQLContext
		): Promise<TournamentParticipant[]> =>
			tournamentsService.getTournamentParticipants(context, args.tournamentId),

		tournamentEntryIds: async (
			_parent: unknown,
			args: TournamentEntryIdsArgs,
			context: GraphQLContext
		): Promise<number[]> => tournamentsService.getTournamentEntryIds(context, args.tournamentId),

		tournamentEventResults: async (
			_parent: unknown,
			args: TournamentEventResultsArgs,
			context: GraphQLContext
		): Promise<TournamentEventResult[]> => {
			const pagination = normalizeTournamentEventResultsPagination(
				args.limit ?? null,
				args.offset ?? null
			);
			await assertTournamentStandingsReady(context, args.tournamentId);
			return tournamentsService.getTournamentEventResults(
				context,
				args.tournamentId,
				args.eventId,
				pagination.limit,
				pagination.offset === 0 && (args.offset === null || args.offset === undefined)
					? null
					: pagination.offset
			);
		},

		tournamentEntryRankingSummary: async (
			_parent: unknown,
			args: TournamentEntryRankingSummaryArgs,
			context: GraphQLContext
		): Promise<TournamentEntryRankingSummary> => {
			await assertTournamentInsightsReady(context, args.tournamentId);
			return tournamentsService.getTournamentEntryRankingSummary(
				context,
				args.tournamentId,
				args.eventId,
				args.entryId
			);
		},

		tournamentSeasonSnapshot: async (
			_parent: unknown,
			args: TournamentSeasonSnapshotArgs,
			context: GraphQLContext
		): Promise<TournamentSeasonSnapshot> => {
			await assertTournamentInsightsReady(context, args.tournamentId);
			return tournamentsService.getTournamentSeasonSnapshot(
				context,
				args.tournamentId,
				args.eventId
			);
		},

		tournamentBattleGroupResults: async (
			_parent: unknown,
			args: TournamentBattleGroupResultsArgs,
			context: GraphQLContext
		): Promise<TournamentBattleGroupResult[]> => {
			await assertTournamentStandingsReady(context, args.tournamentId);
			return tournamentsService.getTournamentBattleGroupResults(
				context,
				args.tournamentId,
				args.eventId
			);
		},

		entryH2HMatchResults: async (
			_parent: unknown,
			args: EntryH2HMatchResultsArgs,
			context: GraphQLContext
		): Promise<EntryH2HMatchResult[]> =>
			tournamentsService.getEntryH2HMatchResults(context, args.entryId),

		tournamentOfficialH2H: async (
			_parent: unknown,
			args: TournamentOfficialH2HArgs,
			context: GraphQLContext
		) => readTournamentOfficialH2HV2(context, args.tournamentId, args.eventId),

		tournamentOfficialH2HHistory: async (
			_parent: unknown,
			args: TournamentOfficialH2HHistoryArgs,
			context: GraphQLContext
		): Promise<TournamentOfficialH2HHistory> => {
			const viewerEntryId = context.principal
				? (viewerEntryIdForPrincipal(context.principal) ?? 0)
				: 0;
			const membership =
				context.authorizedTournamentMemberships?.has(args.tournamentId) === true ? true : null;
			await assertLiveTournamentAccessV2(context, args.tournamentId, viewerEntryId, membership);
			const tournament = await tournamentsService.getTournamentInfoUncached(
				context,
				args.tournamentId
			);
			if (
				!tournament ||
				tournament.leagueType !== LeagueType.H2H ||
				tournament.rosterMode !== TournamentRosterMode.OFFICIAL_SYNC ||
				tournament.groupMode !== GroupMode.BATTLE_RACES
			) {
				throw new GraphQLError(
					"Official H2H history is only available for official H2H tournaments",
					{
						extensions: { code: "BAD_USER_INPUT" },
					}
				);
			}
			return tournamentsService.getTournamentOfficialH2HHistory(
				context,
				args.tournamentId,
				args.eventId,
				viewerEntryId,
				args.limit
			);
		},

		tournamentDetailDesk: async (
			_parent: unknown,
			args: { tournamentId: number; entryId: number; eventId?: number | null },
			context: GraphQLContext
		): Promise<TournamentDetailDesk | null> =>
			tournamentsService.getTournamentDetailDesk(
				context,
				args.tournamentId,
				args.entryId,
				args.eventId
			),

		managedTournamentStatus: async (
			_parent: unknown,
			args: { tournamentId: number; entryId: number },
			context: GraphQLContext
		): Promise<ManagedTournamentStatus | null> =>
			tournamentsService.getManagedTournamentStatus(context, args.tournamentId, args.entryId),
	},
	TournamentInfo: {
		leagueType: (parent: TournamentInfo): string => leagueTypeToEnum(parent.leagueType),
		tournamentMode: (parent: TournamentInfo): string => tournamentModeToEnum(parent.tournamentMode),
		groupMode: (parent: TournamentInfo): string | null => groupModeToEnum(parent.groupMode),
		knockoutMode: (parent: TournamentInfo): string | null =>
			knockoutModeToEnum(parent.knockoutMode),
		state: (parent: TournamentInfo): string => tournamentStateToEnum(parent.state),
		setupStatus: (parent: TournamentInfo): string => {
			if (!parent.setupStatus) throw new Error("Tournament setup status is unavailable");
			return tournamentSetupStatusToEnum(parent.setupStatus);
		},
		setupPhase: (parent: TournamentInfo): string =>
			tournamentSetupPhaseToEnum(parent.setupPhase ?? TournamentSetupPhase.READY),
		setupProgressMode: (parent: TournamentInfo): string =>
			tournamentSetupProgressModeToEnum(
				parent.setupProgressMode ?? TournamentSetupProgressMode.DETERMINATE
			),
		rosterMode: (parent: TournamentInfo): string =>
			tournamentRosterModeToEnum(parent.rosterMode ?? TournamentRosterMode.SNAPSHOT),
		rosterSyncStatus: (parent: TournamentInfo): string | null =>
			parent.rosterSyncStatus ? tournamentSetupStatusToEnum(parent.rosterSyncStatus) : null,
		warningSummaries: async (
			parent: TournamentInfo,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<TournamentSetupWarningSummary[]> =>
			parent.warningSummaries ?? getTournamentSetupWarningSummariesMemoized(context, parent.id),
	},
	TournamentSetupWarningSummary: {
		category: (parent: TournamentSetupWarningSummary): string =>
			tournamentSetupWarningCategoryToEnum(parent.category),
	},
	TournamentSetupIssueDiagnostic: {
		category: (parent: TournamentSetupIssueDiagnostic): string =>
			tournamentSetupWarningCategoryToEnum(parent.category),
		severity: (parent: TournamentSetupIssueDiagnostic): string =>
			tournamentSetupIssueSeverityToEnum(parent.severity),
	},
	TournamentEventResult: {
		tournament: (parent: TournamentEventResult): TournamentInfo => parent.tournament,
		event: async (
			parent: TournamentEventResult,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<Event | null> => getEventByIdMemoized(context, parent.eventId),
		captain: async (
			parent: TournamentEventResult,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<Player | null> => {
			if (parent.captainId === null || parent.captainId <= 0) {
				return null;
			}
			return getCaptainByIdMemoized(context, parent.captainId);
		},
		eventChip: (parent: TournamentEventResult): string | null =>
			tournamentResultChipToEnum(parent.eventChip),
	},
	TournamentBattleGroupResult: {
		tournament: (parent: TournamentBattleGroupResult): TournamentInfo => parent.tournament,
		event: async (
			parent: TournamentBattleGroupResult,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<Event | null> => getEventByIdMemoized(context, parent.eventId),
	},
	TournamentDetailDesk: {
		kind: (parent: TournamentDetailDesk): string => parent.kind.toUpperCase(),
	},
	TournamentSetupDesk: {
		status: (parent: NonNullable<TournamentDetailDesk["setup"]>): string =>
			tournamentSetupStatusToEnum(parent.status),
		phase: (parent: NonNullable<TournamentDetailDesk["setup"]>): string =>
			tournamentSetupPhaseToEnum(parent.phase),
		progressMode: (parent: NonNullable<TournamentDetailDesk["setup"]>): string =>
			tournamentSetupProgressModeToEnum(parent.progressMode),
		warningSummaries: async (
			parent: NonNullable<TournamentDetailDesk["setup"]>,
			_args: Record<string, never>,
			context: GraphQLContext
		): Promise<TournamentSetupWarningSummary[]> =>
			parent.warningSummaries.length > 0 || !parent.__tournamentId
				? parent.warningSummaries
				: getTournamentSetupWarningSummariesMemoized(context, parent.__tournamentId),
	},
	ManagedTournamentStatus: {
		state: (parent: ManagedTournamentStatus): string => tournamentStateToEnum(parent.state),
		setupStatus: (parent: ManagedTournamentStatus): string =>
			tournamentSetupStatusToEnum(parent.setupStatus),
		setupPhase: (parent: ManagedTournamentStatus): string =>
			tournamentSetupPhaseToEnum(parent.setupPhase),
		rosterSyncStatus: (parent: ManagedTournamentStatus): string | null =>
			parent.rosterSyncStatus ? tournamentSetupStatusToEnum(parent.rosterSyncStatus) : null,
		setupProgressMode: (parent: ManagedTournamentStatus): string =>
			tournamentSetupProgressModeToEnum(parent.setupProgressMode),
		warningSummaries: (parent: ManagedTournamentStatus): TournamentSetupWarningSummary[] =>
			parent.warningSummaries,
	},
};
