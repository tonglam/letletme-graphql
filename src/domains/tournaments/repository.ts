import { createHash } from "node:crypto";
import { normalizeFplChip } from "../../contracts/fpl-chip";
import { isPlainRecord as isRecord } from "../../contracts/guards";
import type { GraphQLContext } from "../../graphql/context";
import { GraphQLError } from "graphql";
import { getCoreEventSnapshot, getLiveDataSnapshot } from "../../infra/data-snapshot";
import { eventsService } from "../events/service";
import { gqlCacheKey } from "../../infra/cache-key";
import {
	deleteQueryCache,
	QUERY_CACHE_TTL_SECONDS,
	readJsonQueryCache,
	writeQueryCache,
} from "../../infra/query-cache";
import { stableStringify } from "../../infra/stringify";
import { LeagueType } from "../leagues/repository";
import { entryLiveBatchService } from "../entry-live/batch-service";
import { entriesService } from "../entries/service";
import {
	isTraceableOfficialManagerScore,
	managerScoreBoardIsFinal,
	rankTournamentRowsByOfficialEventPoints,
} from "../entry-live/manager-score";
import type { LiveCalcData } from "../entry-live/calc-service";
import {
	competitionBoardCacheKey,
	readCompetitionBoardCache,
	writeCompetitionBoardCache,
} from "../live-desks/competition-board-cache";
import {
	loadTournamentEventEligibility,
	selectTournamentDeskEntryWindow,
} from "../live-desks/tournament-entry-window";

export enum TournamentMode {
	NORMAL = "normal",
}

export enum GroupMode {
	NO_GROUP = "no_group",
	POINTS_RACES = "points_races",
	BATTLE_RACES = "battle_races",
}

export enum KnockoutMode {
	NO_KNOCKOUT = "no_knockout",
	SINGLE_ELIMINATION = "single_elimination",
	DOUBLE_ELIMINATION = "double_elimination",
	HEAD_TO_HEAD = "head_to_head",
}

export enum TournamentState {
	ACTIVE = "active",
	INACTIVE = "inactive",
	FINISHED = "finished",
}

export enum TournamentSetupStatus {
	PENDING = "pending",
	PROCESSING = "processing",
	READY = "ready",
	FAILED = "failed",
}

export enum TournamentSetupPhase {
	QUEUED = "queued",
	SYNCING_ENTRIES = "syncing_entries",
	BUILDING_STRUCTURE = "building_structure",
	CALCULATING_STANDINGS = "calculating_standings",
	ENRICHING_HISTORY = "enriching_history",
	FINALIZING = "finalizing",
	READY = "ready",
	FAILED = "failed",
}

export enum TournamentSetupProgressMode {
	DETERMINATE = "determinate",
	INDETERMINATE = "indeterminate",
}

export enum TournamentSetupWarningCategory {
	PROFILES = "profiles",
	INSIGHTS = "insights",
	RESULTS = "results",
}

export enum TournamentSetupIssueSeverity {
	WARNING = "warning",
	BLOCKING = "blocking",
}

export type TournamentSetupWarningSummary = {
	category: TournamentSetupWarningCategory;
	affectedCount: number;
	/** True only when every unresolved warning in this category is exhausted. */
	repairExhausted?: boolean;
};

export type TournamentSetupIssueDiagnostic = {
	issueKey: string;
	code: string;
	diagnosticCode: string | null;
	category: TournamentSetupWarningCategory;
	severity: TournamentSetupIssueSeverity;
	eventId: number | null;
	affectedEntryIds: number[];
	affectedCount: number;
	repairAttempts: number;
	nextRepairAt: string | null;
	repairExhausted: boolean;
};

export enum TournamentRosterMode {
	SNAPSHOT = "snapshot",
	OFFICIAL_SYNC = "official_sync",
}

export const normalizeTournamentEventResultsPagination = (
	limit: number | null,
	offset: number | null
): { limit: number | null; offset: number | null } => {
	if (limit === null && offset === null) return { limit: null, offset: null };
	if (offset !== null && limit === null) {
		throw new GraphQLError("offset requires limit", { extensions: { code: "BAD_USER_INPUT" } });
	}
	if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)) {
		throw new GraphQLError("limit must be an integer between 1 and 500", {
			extensions: { code: "BAD_USER_INPUT" },
		});
	}
	if (offset !== null && (!Number.isSafeInteger(offset) || offset < 0 || offset > 4999)) {
		throw new GraphQLError("offset must be an integer between 0 and 4999", {
			extensions: { code: "BAD_USER_INPUT" },
		});
	}
	return { limit, offset: offset ?? 0 };
};

export type TournamentInfo = {
	id: number;
	name: string;
	creator: string;
	adminEntryId: number;
	leagueId: number;
	leagueType: LeagueType;
	sourceLeagueName?: string | null;
	rosterMode?: TournamentRosterMode;
	rosterSyncStatus?: TournamentSetupStatus | null;
	rosterLastSyncedAt?: string | null;
	officialScheduleHash?: string | null;
	officialScheduleSyncedAt?: string | null;
	officialScheduleLockedAt?: string | null;
	totalTeamNum: number;
	tournamentMode: TournamentMode;
	groupMode: GroupMode | null;
	groupTeamNum: number | null;
	groupNum: number | null;
	groupStartedEventId: number | null;
	groupEndedEventId: number | null;
	groupAutoAverages: boolean;
	groupRounds: number | null;
	groupPlayAgainstNum: number | null;
	groupQualifyNum: number | null;
	knockoutMode: KnockoutMode | null;
	knockoutTeamNum: number | null;
	knockoutRounds: number | null;
	knockoutEventNum: number | null;
	knockoutStartedEventId: number | null;
	knockoutEndedEventId: number | null;
	knockoutPlayAgainstNum: number | null;
	state: TournamentState;
	setupStatus: TournamentSetupStatus;
	setupPhase?: TournamentSetupPhase;
	setupCompletedUnits?: number;
	setupTotalUnits?: number;
	setupProgressUpdatedAt?: string | null;
	setupProgressMode?: TournamentSetupProgressMode;
	setupAttempt?: number;
	setupMaxAttempts?: number;
	nextRetryAt?: string | null;
	standingsReadyAt?: string | null;
	profilesReadyAt?: string | null;
	insightsReadyAt?: string | null;
	setupHasWarnings?: boolean;
	warningSummaries?: TournamentSetupWarningSummary[];
	setupStartedAt?: string | null;
	setupFinishedAt?: string | null;
	createdAt: string;
	updatedAt: string;
};

export type DbTournamentEntryRow = {
	tournament_id: number;
};

export type TournamentParticipant = {
	entryId: number;
	entryName: string | null;
	playerName: string | null;
};

export type TournamentDetailDesk = {
	tournament: TournamentInfo;
	viewerEntryId: number;
	canManage: boolean;
	participants: TournamentParticipant[];
	unavailableSections: string[];
	setup: {
		status: TournamentSetupStatus;
		phase: TournamentSetupPhase;
		completedUnits: number;
		totalUnits: number;
		hasWarnings: boolean;
		progressMode: TournamentSetupProgressMode;
		attempt: number;
		maxAttempts: number;
		nextRetryAt: string | null;
		warningSummaries: TournamentSetupWarningSummary[];
		__tournamentId?: number;
	} | null;
	officialH2H: TournamentOfficialH2H | null;
	live: {
		eventId: number;
		/** Null when durable manager scores exist without a live publication. */
		revision: string | null;
		state: string;
		partial: boolean;
		failedEntryIds: number[];
		totalEntries: number;
		rows: LiveCalcData[];
	} | null;
	revision: string;
	kind: "setup" | "official_h2h" | "live_points";
	context: {
		season: string;
		coreRevision: string;
		activeEventId: number | null;
		requestedEventId: number;
	};
};

export type ManagedTournamentStatus = {
	revision: string;
	state: TournamentState;
	setupStatus: TournamentSetupStatus;
	setupPhase: TournamentSetupPhase;
	rosterSyncStatus: TournamentSetupStatus | null;
	setupCompletedUnits: number;
	setupTotalUnits: number;
	setupProgressMode: TournamentSetupProgressMode;
	setupAttempt: number;
	setupMaxAttempts: number;
	nextRetryAt: string | null;
	standingsReadyAt: string | null;
	profilesReadyAt: string | null;
	insightsReadyAt: string | null;
	setupHasWarnings: boolean;
	warningSummaries: TournamentSetupWarningSummary[];
	issues: TournamentSetupIssueDiagnostic[];
	updatedAt: string;
};

type DbDateTime = string | Date;

export type DbTournamentInfoRow = {
	id: number;
	name: string;
	creator: string;
	admin_entry_id: number;
	league_id: number;
	league_type: string;
	source_league_name?: string | null;
	roster_mode?: string;
	roster_sync_status?: string | null;
	roster_last_synced_at?: DbDateTime | null;
	official_schedule_hash?: string | null;
	official_schedule_synced_at?: DbDateTime | null;
	official_schedule_locked_at?: DbDateTime | null;
	total_team_num: number;
	tournament_mode: string;
	group_mode: string | null;
	group_team_num: number | null;
	group_num: number | null;
	group_started_event_id: number | null;
	group_ended_event_id: number | null;
	group_auto_averages: boolean;
	group_rounds: number | null;
	group_play_against_num: number | null;
	group_qualify_num: number | null;
	knockout_mode: string | null;
	knockout_team_num: number | null;
	knockout_rounds: number | null;
	knockout_event_num: number | null;
	knockout_started_event_id: number | null;
	knockout_ended_event_id: number | null;
	knockout_play_against_num: number | null;
	state: string;
	setup_status: string;
	setup_phase?: string;
	setup_completed_units?: number;
	setup_total_units?: number;
	setup_progress_updated_at?: DbDateTime | null;
	standings_ready_at?: DbDateTime | null;
	setup_warning_count?: number;
	setup_progress_indeterminate?: boolean;
	setup_attempt?: number;
	setup_max_attempts?: number;
	setup_next_retry_at?: DbDateTime | null;
	profiles_ready_at?: DbDateTime | null;
	insights_ready_at?: DbDateTime | null;
	setup_started_at?: DbDateTime | null;
	setup_finished_at?: DbDateTime | null;
	created_at: DbDateTime;
	updated_at: DbDateTime;
};

export type TournamentEventResult = {
	tournament: TournamentInfo;
	eventId: number;
	groupId: number;
	entryId: number;
	entryName: string | null;
	playerName: string | null;
	eventGroupRank: number | null;
	eventPoints: number | null;
	eventCost: number | null;
	eventNetPoints: number | null;
	eventRank: number | null;
	overallPoints: number | null;
	overallRank: number | null;
	eventChip: string | null;
	captainId: number | null;
	captainPoints: number | null;
	teamValue: number | null;
	bank: number | null;
};

export type TournamentEntryRankingSummary = {
	eventId: number;
	entryId: number;
	overallRank: number | null;
	tournamentOverallRank: number | null;
	teamValue: number | null;
	tournamentTeamValueRank: number | null;
	transfersNum: number | null;
	tournamentTransfersRank: number | null;
	totalCosts: number | null;
	tournamentCostsRank: number | null;
	totalBenchPoints: number | null;
	tournamentBenchPointsRank: number | null;
	autoSubPoints: number | null;
	tournamentAutoSubRank: number | null;
	/** FPL cumulative total points as of eventId */
	overallPoints: number | null;
	leaderOverallPoints: number | null;
	/** Points behind leader (0 if leading) */
	gapToLeader: number | null;
	/** Points behind the entry immediately above (0 if #1) */
	pointsBehindNext: number | null;
	/** Points ahead of the entry immediately below (0 if last) */
	pointsAheadOfPrev: number | null;
};

export type TournamentSeasonStandingRow = {
	entryId: number;
	rank: number | null;
	entryName: string | null;
	playerName: string | null;
	overallPoints: number | null;
	overallRank: number | null;
	teamValue: number | null;
};

export type TournamentSeasonMetricKey =
	| "OVERALL_POINTS"
	| "TEAM_VALUE"
	| "TRANSFERS"
	| "TOTAL_COSTS"
	| "BENCH_POINTS"
	| "AUTO_SUB_POINTS";

export type TournamentSeasonMetric = {
	key: TournamentSeasonMetricKey;
	leaderValue: number | null;
	leaderEntryId: number | null;
	leaderEntryName: string | null;
	leaderPlayerName: string | null;
	averageValue: number | null;
	higherIsBetter: boolean;
};

export type TournamentSeasonSnapshot = {
	asOfEventId: number;
	entryCount: number;
	leaderOverallPoints: number | null;
	secondOverallPoints: number | null;
	gapFirstSecond: number | null;
	averageOverallPoints: number | null;
	metrics: TournamentSeasonMetric[];
	standings: TournamentSeasonStandingRow[];
};

export type DbTournamentPointsGroupResultRow = {
	tournament_id: number;
	group_id: number;
	event_id: number;
	entry_id: number;
	event_group_rank: number | null;
	event_points: number | null;
	event_cost: number | null;
	event_net_points: number | null;
	event_rank: number | null;
};

export type DbTournamentEventResultRow = {
	tournament_id: number;
	event_id: number;
	entry_id: number;
	group_id: number;
	event_group_rank: number | null;
	event_points: number | null;
	event_cost: number | null;
	event_net_points: number | null;
	event_rank: number | null;
	overall_points: number | null;
	overall_rank: number | null;
	event_chip: string | null;
	captain_id: number | null;
	captain_points: number | null;
	team_value: number | null;
	bank: number | null;
	entry_name: string | null;
	player_name: string | null;
	// Embedded tournament metadata (identical for every row)
	_tournament_id: number;
	_tournament_name: string;
	_tournament_creator: string;
	_tournament_admin_entry_id: number;
	_tournament_league_id: number;
	_tournament_league_type: string;
	_tournament_total_team_num: number;
	_tournament_tournament_mode: string;
	_tournament_group_mode: string | null;
	_tournament_group_team_num: number | null;
	_tournament_group_num: number | null;
	_tournament_group_started_event_id: number | null;
	_tournament_group_ended_event_id: number | null;
	_tournament_group_auto_averages: boolean;
	_tournament_group_rounds: number | null;
	_tournament_group_play_against_num: number | null;
	_tournament_group_qualify_num: number | null;
	_tournament_knockout_mode: string | null;
	_tournament_knockout_team_num: number | null;
	_tournament_knockout_rounds: number | null;
	_tournament_knockout_event_num: number | null;
	_tournament_knockout_started_event_id: number | null;
	_tournament_knockout_ended_event_id: number | null;
	_tournament_knockout_play_against_num: number | null;
	_tournament_state: string;
	_tournament_created_at: DbDateTime;
	_tournament_updated_at: DbDateTime;
};

export type DbLeagueEventResultEnrichmentRow = {
	league_id: number;
	league_type: string;
	event_id: number;
	entry_id: number;
	entry_name: string | null;
	player_name: string | null;
	overall_points: number | null;
	overall_rank: number | null;
	event_chip: string | null;
	captain_id: number | null;
	captain_points: number | null;
	team_value: number | null;
	bank: number | null;
};

export type DbEntryInfoNameRow = {
	id: number;
	entry_name: string | null;
	player_name: string | null;
};

type DbEntryEventResultLiteRow = {
	entry_id: number;
	event_id: number;
	event_points: number;
	event_transfers_cost: number;
	event_chip: string | null;
	overall_rank: number;
};

export type EntryH2HMatchResult = {
	tournament: TournamentInfo;
	matchId: number;
	groupId: number;
	eventId: number;
	entryId: number;
	entryName: string | null;
	playerName: string | null;
	entryNetPoints: number | null;
	entryRank: number | null;
	entryMatchPoints: number | null;
	entryEventPoints: number | null;
	entryTransferCost: number | null;
	entryOverallRank: number | null;
	entryChip: string | null;
	opponentEntryId: number;
	opponentEntryName: string | null;
	opponentPlayerName: string | null;
	opponentNetPoints: number | null;
	opponentRank: number | null;
	opponentMatchPoints: number | null;
	opponentEventPoints: number | null;
	opponentTransferCost: number | null;
	opponentOverallRank: number | null;
	opponentChip: string | null;
};

export type DbTournamentBattleGroupResultRow = {
	id: number;
	tournament_id: number;
	group_id: number;
	event_id: number;
	home_entry_id: number | null;
	home_net_points: number | null;
	home_rank: number | null;
	home_match_points: number | null;
	away_entry_id: number | null;
	away_net_points: number | null;
	away_rank: number | null;
	away_match_points: number | null;
	official_match_id?: number | null;
	source_order?: number | null;
	home_is_average?: boolean;
	away_is_average?: boolean;
	is_bye?: boolean;
	source_checked_at?: string | Date | null;
};

export type TournamentBattleGroupResult = {
	tournament: TournamentInfo;
	matchId: number;
	groupId: number;
	eventId: number;
	homeEntryId: number;
	homeEntryName: string | null;
	homePlayerName: string | null;
	homeNetPoints: number | null;
	homeRank: number | null;
	homeMatchPoints: number | null;
	awayEntryId: number;
	awayEntryName: string | null;
	awayPlayerName: string | null;
	awayNetPoints: number | null;
	awayRank: number | null;
	awayMatchPoints: number | null;
};

export type OfficialH2HStanding = {
	entryId: number;
	entryName: string | null;
	playerName: string | null;
	rank: number | null;
	matchPoints: number;
	played: number;
	won: number;
	drawn: number;
	lost: number;
	pointsFor: number;
};

export type OfficialH2HMatchSide = {
	entryId: number | null;
	entryName: string;
	playerName: string | null;
	isAverage: boolean;
	points: number | null;
	matchPoints: number | null;
};

export type OfficialH2HMatch = {
	officialMatchId: number;
	eventId: number;
	sourceOrder: number;
	phase: "REGULAR" | "KNOCKOUT";
	knockoutName: string | null;
	isBye: boolean;
	home: OfficialH2HMatchSide;
	away: OfficialH2HMatchSide;
	winnerEntryId: number | null;
	tiebreak: string | null;
	sourceCheckedAt: string | null;
};

export type TournamentOfficialH2H = {
	tournament: TournamentInfo;
	eventId: number;
	awaitingSchedule: boolean;
	scoreSource: "FPL_EVENT_LIVE" | "FPL_H2H_FINAL" | "UNAVAILABLE";
	scoreRevision: string | null;
	scoreCheckedAt: string | null;
	standings: OfficialH2HStanding[];
	matches: OfficialH2HMatch[];
};

export type EntryOfficialH2HDeskItem = {
	tournamentId: number;
	tournamentName: string;
	totalTeams: number;
	eventId: number;
	awaitingSchedule: boolean;
	isLive: boolean;
	isFinal: boolean;
	scoreSource: TournamentOfficialH2H["scoreSource"];
	scoreRevision: string | null;
	scoreCheckedAt: string | null;
	rank: number | null;
	lastRank: number | null;
	matchPoints: number;
	/** Internal read-side evidence; intentionally not exposed by the GraphQL schema. */
	standingsPublished: boolean;
	standingsCurrentEventComplete: boolean;
	match: OfficialH2HMatch | null;
	matches: OfficialH2HMatch[];
};

type DbTournamentGroupRow = {
	tournament_id: number;
	entry_id: number;
	group_points: number | null;
	group_rank: number | null;
	played: number | null;
	won: number | null;
	drawn: number | null;
	lost: number | null;
	total_net_points: number | null;
};

type DbTournamentKnockoutResultRow = {
	tournament_id: number;
	event_id: number;
	home_entry_id: number | null;
	home_net_points: number | null;
	away_entry_id: number | null;
	away_net_points: number | null;
	match_winner: number | null;
	official_match_id: number | null;
	source_order: number | null;
	knockout_name: string | null;
	tiebreak: string | null;
	source_checked_at: string | Date | null;
};

type DbEventStateRow = {
	id: number;
	finished: boolean;
	data_checked: boolean;
	is_current: boolean;
	is_next: boolean;
};

export function resolveOfficialH2HReferenceEventId(events: readonly DbEventStateRow[]): number {
	const latestCheckedEvent = [...events]
		.filter((event) => event.finished && event.data_checked)
		.sort((left, right) => right.id - left.id)[0];
	return (
		events.find((event) => event.is_current)?.id ??
		events.find((event) => event.is_next)?.id ??
		latestCheckedEvent?.id ??
		39
	);
}

const OFFICIAL_BATTLE_COLUMNS =
	"id, tournament_id, group_id, event_id, home_entry_id, home_net_points, home_rank, home_match_points, away_entry_id, away_net_points, away_rank, away_match_points, official_match_id, source_order, home_is_average, away_is_average, is_bye, source_checked_at";

function normalizeOfficialH2HSourceCheckedAt(
	value: string | Date | null | undefined
): string | null {
	if (value === null || value === undefined || value === "") return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function officialMatchSide(
	entryId: number | null,
	isAverage: boolean,
	points: number | null,
	matchPoints: number | null,
	entryNames: Map<number, DbEntryInfoNameRow>
): OfficialH2HMatchSide {
	const entry = entryId === null ? null : entryNames.get(entryId);
	return {
		entryId,
		entryName: isAverage
			? "Average Team"
			: entryId === null
				? "Bye"
				: (entry?.entry_name ?? `Entry ${entryId}`),
		playerName: isAverage ? null : (entry?.player_name ?? null),
		isAverage,
		points,
		matchPoints,
	};
}

type HistoricalH2HStandingProjection = Omit<OfficialH2HStanding, "entryName" | "playerName">;

type OfficialH2HProjectionOptions = {
	/** Only use score-derived outcomes for events with finalized evidence. */
	finalizedEventIds?: ReadonlySet<number>;
	/** Live events whose complete score batch has been validated against the roster. */
	provisionalEventIds?: ReadonlySet<number>;
	/** Live events whose incomplete batch must not expose partial outcomes. */
	suppressedEventIds?: ReadonlySet<number>;
	/** Provisional score batches derived from one coherent event-live revision. */
	trustedEventLiveEventIds?: ReadonlySet<number>;
};

function resolvedOfficialMatchPoints(
	row: DbTournamentBattleGroupResultRow,
	options: OfficialH2HProjectionOptions = {}
): {
	home: number | null;
	away: number | null;
} {
	if (row.is_bye === true || options.suppressedEventIds?.has(row.event_id) === true) {
		return { home: null, away: null };
	}
	const homePoints = row.home_net_points;
	const awayPoints = row.away_net_points;
	const hasFinalizedEvidence = options.finalizedEventIds?.has(row.event_id) === true;
	const hasProvisionalEvidence = options.provisionalEventIds?.has(row.event_id) === true;
	// A complete live or finalized score batch is the newest evidence. Its saved
	// outcome fields can still describe the preceding score snapshot, so prefer
	// validated scores whenever both sides are present.
	if (
		(hasProvisionalEvidence || hasFinalizedEvidence) &&
		typeof homePoints === "number" &&
		typeof awayPoints === "number"
	) {
		if (homePoints > awayPoints) return { home: 3, away: 0 };
		if (homePoints < awayPoints) return { home: 0, away: 3 };
		return { home: 1, away: 1 };
	}
	if (
		row.home_match_points !== null &&
		row.home_match_points !== undefined &&
		row.away_match_points !== null &&
		row.away_match_points !== undefined
	) {
		return { home: row.home_match_points, away: row.away_match_points };
	}
	const hasScoreEvidence =
		options.finalizedEventIds === undefined || hasFinalizedEvidence || hasProvisionalEvidence;
	// FPL can publish scores before its per-match outcome fields. Do not derive
	// a live result from moving points until the entire round is available;
	// finalized and complete-live 0-0 scores are real draws.
	if (
		typeof homePoints !== "number" ||
		typeof awayPoints !== "number" ||
		!hasScoreEvidence ||
		(homePoints === 0 && awayPoints === 0 && !hasFinalizedEvidence && !hasProvisionalEvidence)
	) {
		return { home: null, away: null };
	}
	if (homePoints > awayPoints) return { home: 3, away: 0 };
	if (homePoints < awayPoints) return { home: 0, away: 3 };
	return { home: 1, away: 1 };
}

export function projectOfficialH2HStandingsFromResults(
	entryIds: readonly number[],
	rows: readonly DbTournamentBattleGroupResultRow[],
	options: OfficialH2HProjectionOptions = {}
): HistoricalH2HStandingProjection[] {
	const totals = new Map<number, Omit<HistoricalH2HStandingProjection, "rank">>();
	for (const entryId of entryIds) {
		totals.set(entryId, {
			entryId,
			matchPoints: 0,
			played: 0,
			won: 0,
			drawn: 0,
			lost: 0,
			pointsFor: 0,
		});
	}
	for (const row of rows) {
		const outcome = resolvedOfficialMatchPoints(row, options);
		const sides = [
			{
				entryId: row.home_entry_id,
				points: row.home_net_points,
				matchPoints: outcome.home,
			},
			{
				entryId: row.away_entry_id,
				points: row.away_net_points,
				matchPoints: outcome.away,
			},
		];
		for (const side of sides) {
			if (side.entryId === null || side.matchPoints === null) continue;
			const total = totals.get(side.entryId);
			if (!total) continue;
			total.played += 1;
			total.matchPoints += side.matchPoints;
			total.pointsFor += side.points ?? 0;
			if (side.matchPoints === 3) total.won += 1;
			else if (side.matchPoints === 1) total.drawn += 1;
			else total.lost += 1;
		}
	}

	const ordered = [...totals.values()].sort(
		(left, right) =>
			right.matchPoints - left.matchPoints ||
			right.pointsFor - left.pointsFor ||
			left.entryId - right.entryId
	);
	let previousKey: string | null = null;
	let rank = 0;
	return ordered.map((standing, index) => {
		const key = `${standing.matchPoints}:${standing.pointsFor}`;
		if (key !== previousKey) rank = index + 1;
		previousKey = key;
		return { ...standing, rank };
	});
}

export function projectHistoricalOfficialH2HStandings(
	entryIds: readonly number[],
	rows: readonly DbTournamentBattleGroupResultRow[],
	options: OfficialH2HProjectionOptions = {}
): HistoricalH2HStandingProjection[] {
	return projectOfficialH2HStandingsFromResults(entryIds, rows, options);
}

function mapOfficialBattleMatch(
	row: DbTournamentBattleGroupResultRow,
	entryNames: Map<number, DbEntryInfoNameRow>,
	options: OfficialH2HProjectionOptions = { finalizedEventIds: new Set() }
): OfficialH2HMatch {
	if (
		row.official_match_id === null ||
		row.official_match_id === undefined ||
		row.source_order === null ||
		row.source_order === undefined
	) {
		throw new Error("Official H2H battle row is missing source identity");
	}
	const outcome = resolvedOfficialMatchPoints(row, options);
	const scoreSuppressed = options.suppressedEventIds?.has(row.event_id) === true;
	const winnerEntryId =
		outcome.home === 3 ? row.home_entry_id : outcome.away === 3 ? row.away_entry_id : null;
	return {
		officialMatchId: row.official_match_id,
		eventId: row.event_id,
		sourceOrder: row.source_order,
		phase: "REGULAR",
		knockoutName: null,
		isBye: row.is_bye ?? false,
		home: officialMatchSide(
			row.home_entry_id,
			row.home_is_average ?? row.home_entry_id === null,
			scoreSuppressed ? null : row.home_net_points,
			outcome.home,
			entryNames
		),
		away: officialMatchSide(
			row.away_entry_id,
			row.away_is_average ?? row.away_entry_id === null,
			scoreSuppressed ? null : row.away_net_points,
			outcome.away,
			entryNames
		),
		winnerEntryId,
		tiebreak: null,
		sourceCheckedAt: normalizeOfficialH2HSourceCheckedAt(row.source_checked_at),
	};
}

function mapOfficialKnockoutMatch(
	row: DbTournamentKnockoutResultRow,
	entryNames: Map<number, DbEntryInfoNameRow>
): OfficialH2HMatch {
	if (row.official_match_id === null || row.source_order === null) {
		throw new Error("Official H2H knockout row is missing source identity");
	}
	return {
		officialMatchId: row.official_match_id,
		eventId: row.event_id,
		sourceOrder: row.source_order,
		phase: "KNOCKOUT",
		knockoutName: row.knockout_name,
		isBye: row.home_entry_id === null || row.away_entry_id === null,
		home: officialMatchSide(
			row.home_entry_id,
			false,
			row.home_net_points,
			row.match_winner === null ? null : row.match_winner === row.home_entry_id ? 3 : 0,
			entryNames
		),
		away: officialMatchSide(
			row.away_entry_id,
			false,
			row.away_net_points,
			row.match_winner === null ? null : row.match_winner === row.away_entry_id ? 3 : 0,
			entryNames
		),
		winnerEntryId: row.match_winner,
		tiebreak: row.tiebreak,
		sourceCheckedAt: normalizeOfficialH2HSourceCheckedAt(row.source_checked_at),
	};
}

function isOfficialH2HInfo(tournament: TournamentInfo): boolean {
	return (
		tournament.leagueType === LeagueType.H2H &&
		tournament.rosterMode === TournamentRosterMode.OFFICIAL_SYNC &&
		tournament.groupMode === GroupMode.BATTLE_RACES
	);
}

export type OfficialH2HSnapshotLoad = {
	snapshot: TournamentOfficialH2H;
	history: DbTournamentBattleGroupResultRow[];
	standingsPublished: boolean;
	currentEventComplete: boolean;
	validatedFinalizedEventIds: ReadonlySet<number>;
};

function officialBattleRowsAreCompleteForEntries(
	entryIds: readonly number[],
	rows: readonly DbTournamentBattleGroupResultRow[],
	options: OfficialH2HProjectionOptions = {}
): boolean {
	const expectedEntryIds = new Set(entryIds);
	if (
		expectedEntryIds.size === 0 ||
		expectedEntryIds.size !== entryIds.length ||
		rows.length === 0 ||
		new Set(rows.map((row) => row.event_id)).size !== 1
	) {
		return false;
	}

	const scheduledEntryIds = new Set<number>();
	let hasNonZeroProvisionalScore = false;
	let containsProvisionalRows = false;
	let containsTrustedEventLiveRows = false;
	let containsScoreAuthoritativeRows = false;
	const scoreBatchMarkers = new Set<string>();
	for (const row of rows) {
		const realSides = [row.home_entry_id, row.away_entry_id].filter(
			(entryId): entryId is number => entryId !== null
		);
		if (new Set(realSides).size !== realSides.length) return false;
		if (realSides.some((entryId) => !expectedEntryIds.has(entryId))) return false;
		if (realSides.some((entryId) => scheduledEntryIds.has(entryId))) return false;
		for (const entryId of realSides) scheduledEntryIds.add(entryId);

		const isProvisional = options.provisionalEventIds?.has(row.event_id) === true;
		const isFinalized = options.finalizedEventIds?.has(row.event_id) === true;
		const isTrustedEventLive = options.trustedEventLiveEventIds?.has(row.event_id) === true;
		if (isProvisional || isFinalized) {
			containsScoreAuthoritativeRows = true;
			// Data atomically publishes one official H2H round with one checked-at value.
			// Mixed markers mean this read observed an incremental or partial round.
			const batchMarker = normalizeOfficialH2HSourceCheckedAt(row.source_checked_at);
			if (!batchMarker) return false;
			scoreBatchMarkers.add(batchMarker);
		}
		if (isProvisional) {
			containsProvisionalRows = true;
			containsTrustedEventLiveRows ||= isTrustedEventLive;
		}

		if (row.is_bye === true) {
			if (realSides.length !== 1) return false;
			continue;
		}
		if (realSides.length === 0) return false;
		if (row.home_entry_id === null && row.home_is_average !== true) return false;
		if (row.away_entry_id === null && row.away_is_average !== true) return false;
		if (row.home_entry_id !== null && row.home_is_average === true) return false;
		if (row.away_entry_id !== null && row.away_is_average === true) return false;

		if (isProvisional) {
			if (typeof row.home_net_points !== "number" || typeof row.away_net_points !== "number") {
				return false;
			}
			if (row.home_net_points !== 0 || row.away_net_points !== 0) {
				hasNonZeroProvisionalScore = true;
			}
			continue;
		}
		const outcome = resolvedOfficialMatchPoints(row, options);
		if (outcome.home === null || outcome.away === null) return false;
	}
	return (
		scheduledEntryIds.size === expectedEntryIds.size &&
		[...expectedEntryIds].every((entryId) => scheduledEntryIds.has(entryId)) &&
		(!containsScoreAuthoritativeRows || scoreBatchMarkers.size === 1) &&
		(!containsProvisionalRows || hasNonZeroProvisionalScore || containsTrustedEventLiveRows)
	);
}

type OfficialKnockoutRoundConfig = Pick<
	TournamentInfo,
	"knockoutTeamNum" | "knockoutStartedEventId"
> &
	Partial<
		Pick<
			TournamentInfo,
			"knockoutMode" | "knockoutRounds" | "knockoutEventNum" | "knockoutPlayAgainstNum"
		>
	>;

function resolveOfficialKnockoutStructure(
	tournament: OfficialKnockoutRoundConfig
): { bracketSize: number; rounds: number; eventsPerOpponent: number } | null {
	if (tournament.knockoutMode === KnockoutMode.NO_KNOCKOUT) return null;
	const teamCount = tournament.knockoutTeamNum ?? 0;
	if (!Number.isSafeInteger(teamCount) || teamCount < 2) return null;
	const rounds = Math.ceil(Math.log2(teamCount));
	const bracketSize = 2 ** rounds;
	const configuredEventsPerOpponent = tournament.knockoutPlayAgainstNum;
	const eventsPerOpponent =
		configuredEventsPerOpponent !== null &&
		configuredEventsPerOpponent !== undefined &&
		Number.isSafeInteger(configuredEventsPerOpponent) &&
		configuredEventsPerOpponent >= 1
			? configuredEventsPerOpponent
			: tournament.knockoutMode === KnockoutMode.DOUBLE_ELIMINATION
				? 2
				: 1;

	// Current Data rows store bracket stages in knockoutEventNum and elapsed
	// gameweeks in knockoutRounds. Older/imported rows can use the opposite
	// naming. Require one configured representation to reconcile to the bracket
	// implied by the team count, including multi-event ties, before trusting it.
	const configuredCounts = [
		tournament.knockoutRounds,
		tournament.knockoutEventNum,
		tournament.knockoutRounds === null || tournament.knockoutRounds === undefined
			? null
			: tournament.knockoutRounds / eventsPerOpponent,
		tournament.knockoutEventNum === null || tournament.knockoutEventNum === undefined
			? null
			: tournament.knockoutEventNum / eventsPerOpponent,
	].filter(
		(value): value is number =>
			typeof value === "number" && Number.isSafeInteger(value) && value >= 1
	);
	if (configuredCounts.length > 0 && !configuredCounts.includes(rounds)) return null;

	return { bracketSize, rounds, eventsPerOpponent };
}

function resolveOfficialKnockoutRound(
	tournament: OfficialKnockoutRoundConfig,
	eventId: number,
	knockoutName: string | null
): number | null {
	const structure = resolveOfficialKnockoutStructure(tournament);
	if (!structure) return null;
	const { rounds, eventsPerOpponent } = structure;
	const normalizedName = knockoutName?.trim().toLowerCase() ?? "";
	const round = normalizedName.includes("quarter")
		? Math.max(1, rounds - 2)
		: normalizedName.includes("semi")
			? Math.max(1, rounds - 1)
			: normalizedName.includes("final")
				? rounds
				: tournament.knockoutStartedEventId === null
					? null
					: Math.min(
							Math.max(
								Math.floor((eventId - tournament.knockoutStartedEventId) / eventsPerOpponent) + 1,
								1
							),
							rounds
						);
	return round !== null && round >= 1 && round <= rounds ? round : null;
}

function expectedOfficialKnockoutMatches(
	tournament: OfficialKnockoutRoundConfig,
	eventId: number,
	knockoutName: string | null
): { round: number; matches: number } | null {
	const structure = resolveOfficialKnockoutStructure(tournament);
	const round = resolveOfficialKnockoutRound(tournament, eventId, knockoutName);
	if (!structure || round === null) return null;
	const matches = structure.bracketSize / 2 ** round;
	return Number.isSafeInteger(matches) && matches >= 1 ? { round, matches } : null;
}

function officialKnockoutRowsAreCompleteForFinalizedEvent(
	rows: readonly DbTournamentKnockoutResultRow[],
	eventId: number,
	tournament: OfficialKnockoutRoundConfig
): boolean {
	if (rows.length === 0 || rows.some((row) => row.event_id !== eventId)) return false;

	const matchIds = new Set<number>();
	const sourceOrders = new Set<number>();
	const scheduledEntryIds = new Set<number>();
	const scoreBatchMarkers = new Set<string>();
	let expectedRound: number | null = null;
	let expectedMatches: number | null = null;
	for (const row of rows) {
		const bracket = expectedOfficialKnockoutMatches(tournament, eventId, row.knockout_name);
		if (
			!bracket ||
			(expectedRound !== null && expectedRound !== bracket.round) ||
			(expectedMatches !== null && expectedMatches !== bracket.matches)
		) {
			return false;
		}
		expectedRound = bracket.round;
		expectedMatches = bracket.matches;
		if (
			row.official_match_id === null ||
			!Number.isSafeInteger(row.official_match_id) ||
			row.source_order === null ||
			!Number.isSafeInteger(row.source_order) ||
			matchIds.has(row.official_match_id) ||
			sourceOrders.has(row.source_order)
		) {
			return false;
		}
		matchIds.add(row.official_match_id);
		sourceOrders.add(row.source_order);

		const batchMarker = normalizeOfficialH2HSourceCheckedAt(row.source_checked_at);
		if (!batchMarker) return false;
		scoreBatchMarkers.add(batchMarker);

		const sides = [row.home_entry_id, row.away_entry_id].filter(
			(entryId): entryId is number => entryId !== null
		);
		if (sides.length === 0 || new Set(sides).size !== sides.length) return false;
		if (sides.some((entryId) => scheduledEntryIds.has(entryId))) return false;
		for (const entryId of sides) scheduledEntryIds.add(entryId);
		if (row.match_winner === null || !sides.includes(row.match_winner)) return false;
		if (sides.length === 1) continue;
		if (typeof row.home_net_points !== "number" || typeof row.away_net_points !== "number") {
			return false;
		}
		if (
			row.home_net_points !== row.away_net_points &&
			row.match_winner !==
				(row.home_net_points > row.away_net_points ? row.home_entry_id : row.away_entry_id)
		) {
			return false;
		}
	}
	return expectedMatches === rows.length && scoreBatchMarkers.size === 1;
}

function officialH2HCurrentEventIsComplete(
	battleRoundComplete: boolean,
	battleRows: readonly DbTournamentBattleGroupResultRow[],
	knockoutRows: readonly DbTournamentKnockoutResultRow[],
	eventId: number,
	finalizedEventIds: ReadonlySet<number>,
	tournament: OfficialKnockoutRoundConfig
): boolean {
	if (!finalizedEventIds.has(eventId)) return battleRoundComplete;
	const hasBattleRound = battleRows.length > 0;
	const hasKnockoutRound = knockoutRows.length > 0;
	if (!hasBattleRound && !hasKnockoutRound) return false;
	const batchMarkers = new Set<string>();
	for (const row of [...battleRows, ...knockoutRows]) {
		const marker = normalizeOfficialH2HSourceCheckedAt(row.source_checked_at);
		if (!marker) return false;
		batchMarkers.add(marker);
	}
	return (
		batchMarkers.size === 1 &&
		(!hasBattleRound || battleRoundComplete) &&
		(!hasKnockoutRound ||
			officialKnockoutRowsAreCompleteForFinalizedEvent(knockoutRows, eventId, tournament))
	);
}

type OfficialH2HProjectionSelection = {
	standings: HistoricalH2HStandingProjection[] | null;
	options: OfficialH2HProjectionOptions;
	currentEventComplete: boolean;
	storedPlayed: number;
	derivedPlayed: number;
};

function selectCurrentOfficialH2HProjection(
	expectedEntryCount: number,
	groups: readonly DbTournamentGroupRow[],
	currentEventRows: readonly DbTournamentBattleGroupResultRow[],
	historyRows: readonly DbTournamentBattleGroupResultRow[],
	eventId: number,
	activeEventId: number,
	finalizedEventIds: ReadonlySet<number>
): OfficialH2HProjectionSelection {
	const entryIds = groups.map((row) => row.entry_id);
	const rosterIsComplete =
		entryIds.length === expectedEntryCount && new Set(entryIds).size === expectedEntryCount;
	const finalizedCandidate = finalizedEventIds.has(eventId);
	const provisionalCandidate = eventId === activeEventId && !finalizedCandidate ? eventId : null;
	const finalizedRowsByEvent = new Map<number, DbTournamentBattleGroupResultRow[]>();
	for (const row of historyRows) {
		if (!finalizedEventIds.has(row.event_id)) continue;
		const rows = finalizedRowsByEvent.get(row.event_id) ?? [];
		rows.push(row);
		finalizedRowsByEvent.set(row.event_id, rows);
	}
	const validatedFinalizedEventIds = new Set<number>();
	const rejectedFinalizedEventIds = new Set<number>();
	for (const [candidateEventId, rows] of finalizedRowsByEvent) {
		const complete =
			rosterIsComplete &&
			officialBattleRowsAreCompleteForEntries(entryIds, rows, {
				finalizedEventIds: new Set([candidateEventId]),
			});
		if (complete) validatedFinalizedEventIds.add(candidateEventId);
		else rejectedFinalizedEventIds.add(candidateEventId);
	}
	if (finalizedCandidate && !validatedFinalizedEventIds.has(eventId)) {
		rejectedFinalizedEventIds.add(eventId);
	}
	const completeProvisionalEvent =
		rosterIsComplete &&
		provisionalCandidate !== null &&
		officialBattleRowsAreCompleteForEntries(entryIds, currentEventRows, {
			provisionalEventIds: new Set([provisionalCandidate]),
		});
	const completeCurrentEvent = finalizedCandidate
		? validatedFinalizedEventIds.has(eventId)
		: completeProvisionalEvent;
	const suppressedEventIds = new Set(rejectedFinalizedEventIds);
	if (!completeCurrentEvent && provisionalCandidate !== null) {
		suppressedEventIds.add(provisionalCandidate);
	}
	const options: OfficialH2HProjectionOptions = {
		finalizedEventIds: validatedFinalizedEventIds,
		provisionalEventIds:
			completeCurrentEvent && provisionalCandidate !== null
				? new Set([provisionalCandidate])
				: new Set<number>(),
		suppressedEventIds,
	};
	const storedPlayed = groups.reduce((total, row) => total + Math.max(0, row.played ?? 0), 0);
	if (!completeCurrentEvent) {
		return {
			standings: null,
			options,
			currentEventComplete: false,
			storedPlayed,
			derivedPlayed: 0,
		};
	}

	const derived = projectOfficialH2HStandingsFromResults(entryIds, historyRows, options);
	const derivedPlayed = derived.reduce((total, row) => total + row.played, 0);
	const storedByEntry = new Map(groups.map((row) => [row.entry_id, row]));
	const derivedCoverageIsAtLeastStored = derived.every((row) => {
		const stored = storedByEntry.get(row.entryId);
		return stored !== undefined && row.played >= Math.max(0, stored.played ?? 0);
	});
	const hasLaggingStoredEntry =
		derivedCoverageIsAtLeastStored &&
		derived.some((row) => {
			const stored = storedByEntry.get(row.entryId);
			return (
				!stored ||
				(stored.group_points ?? 0) !== row.matchPoints ||
				(stored.played ?? 0) !== row.played ||
				(stored.won ?? 0) !== row.won ||
				(stored.drawn ?? 0) !== row.drawn ||
				(stored.lost ?? 0) !== row.lost ||
				(stored.total_net_points ?? 0) !== row.pointsFor
			);
		});
	return {
		// Equal played counts do not prove that the stored table has caught up:
		// a newer atomic score batch can change outcomes, PF and ranks in-place.
		// If any stored entry has more result coverage, keep the whole table authoritative.
		standings: hasLaggingStoredEntry ? derived : null,
		options,
		currentEventComplete: true,
		storedPlayed,
		derivedPlayed,
	};
}

async function loadOfficialH2HSnapshots(
	context: GraphQLContext,
	tournaments: readonly TournamentInfo[],
	eventId: number,
	activeEventId: number,
	includeHistory: boolean,
	finalizedEventIds: ReadonlySet<number> = new Set()
): Promise<Map<number, OfficialH2HSnapshotLoad>> {
	const tournamentIds = tournaments.map((tournament) => tournament.id);
	const needsHistoryForFallback = finalizedEventIds.has(eventId) || eventId === activeEventId;
	const shouldLoadHistory = includeHistory || needsHistoryForFallback;
	const currentEventBattleQuery = shouldLoadHistory
		? Promise.resolve({ data: [] as DbTournamentBattleGroupResultRow[], error: null })
		: context.data
				.read("competition.tournament_battle_group_results")
				.select(OFFICIAL_BATTLE_COLUMNS)
				.in("tournament_id", tournamentIds)
				.eq("event_id", eventId)
				.not("official_match_id", "is", null)
				.order("event_id", { ascending: true })
				.order("source_order", { ascending: true })
				.order("official_match_id", { ascending: true });
	const [groupResult, battleResult, knockoutResult] = await Promise.all([
		context.data
			.read("competition.tournament_groups")
			.select(
				"tournament_id, entry_id, group_points, group_rank, played, won, drawn, lost, total_net_points"
			)
			.in("tournament_id", tournamentIds)
			.order("group_rank", { ascending: true })
			.order("entry_id", { ascending: true }),
		currentEventBattleQuery,
		context.data
			.read("competition.tournament_knockout_results")
			.select(
				"tournament_id, event_id, home_entry_id, home_net_points, away_entry_id, away_net_points, match_winner, official_match_id, source_order, knockout_name, tiebreak, source_checked_at"
			)
			.in("tournament_id", tournamentIds)
			.eq("event_id", eventId)
			.not("official_match_id", "is", null)
			.order("event_id", { ascending: true })
			.order("source_order", { ascending: true })
			.order("official_match_id", { ascending: true }),
	]);
	if (groupResult.error || battleResult.error || knockoutResult.error) {
		context.logger.error(
			{
				err: groupResult.error ?? battleResult.error ?? knockoutResult.error,
				tournamentIds,
				eventId,
			},
			"Failed to fetch official H2H mirror"
		);
		throw new Error("Failed to fetch official H2H mirror");
	}

	const groups = (groupResult.data as DbTournamentGroupRow[] | null) ?? [];
	const battles = (battleResult.data as DbTournamentBattleGroupResultRow[] | null) ?? [];
	const knockouts = (knockoutResult.data as DbTournamentKnockoutResultRow[] | null) ?? [];
	let historyRows: DbTournamentBattleGroupResultRow[] = [];
	if (shouldLoadHistory) {
		const historyResult = await context.data
			.read("competition.tournament_battle_group_results")
			.select(OFFICIAL_BATTLE_COLUMNS)
			.in("tournament_id", tournamentIds)
			.lte("event_id", eventId)
			.not("official_match_id", "is", null)
			.order("tournament_id", { ascending: true })
			.order("event_id", { ascending: true })
			.order("source_order", { ascending: true });
		if (historyResult.error) {
			context.logger.error(
				{ err: historyResult.error, tournamentIds, eventId },
				"Failed to fetch official H2H history"
			);
			throw new Error("Failed to fetch official H2H mirror history");
		}
		historyRows = (historyResult.data as DbTournamentBattleGroupResultRow[] | null) ?? [];
	}
	const entryIds = [
		...new Set(
			[
				...groups.map((row) => row.entry_id),
				...battles.flatMap((row) => [row.home_entry_id, row.away_entry_id]),
				...historyRows.flatMap((row) => [row.home_entry_id, row.away_entry_id]),
				...knockouts.flatMap((row) => [row.home_entry_id, row.away_entry_id]),
			].filter((entryId): entryId is number => entryId !== null)
		),
	];
	const nameResult =
		entryIds.length === 0
			? { data: [] as DbEntryInfoNameRow[], error: null }
			: await context.data
					.read("competition.entries")
					.select("id, entry_name, player_name")
					.in("id", entryIds);
	if (nameResult.error) throw new Error("Failed to fetch official H2H entry names");
	const entryNames = new Map<number, DbEntryInfoNameRow>(
		((nameResult.data as DbEntryInfoNameRow[] | null) ?? []).map((row) => [row.id, row])
	);

	const groupsByTournament = new Map<number, DbTournamentGroupRow[]>();
	for (const row of groups) {
		const bucket = groupsByTournament.get(row.tournament_id) ?? [];
		bucket.push(row);
		groupsByTournament.set(row.tournament_id, bucket);
	}
	const battlesByTournament = new Map<number, DbTournamentBattleGroupResultRow[]>();
	for (const row of battles) {
		const bucket = battlesByTournament.get(row.tournament_id) ?? [];
		bucket.push(row);
		battlesByTournament.set(row.tournament_id, bucket);
	}
	const knockoutsByTournament = new Map<number, DbTournamentKnockoutResultRow[]>();
	for (const row of knockouts) {
		const bucket = knockoutsByTournament.get(row.tournament_id) ?? [];
		bucket.push(row);
		knockoutsByTournament.set(row.tournament_id, bucket);
	}
	const historyByTournament = new Map<number, DbTournamentBattleGroupResultRow[]>();
	for (const row of historyRows) {
		const bucket = historyByTournament.get(row.tournament_id) ?? [];
		bucket.push(row);
		historyByTournament.set(row.tournament_id, bucket);
	}

	const loaded = new Map<number, OfficialH2HSnapshotLoad>();
	for (const tournament of tournaments) {
		const tournamentGroups = groupsByTournament.get(tournament.id) ?? [];
		const tournamentBattles = battlesByTournament.get(tournament.id) ?? [];
		const tournamentKnockouts = knockoutsByTournament.get(tournament.id) ?? [];
		const tournamentHistory = historyByTournament.get(tournament.id) ?? [];
		const currentEventHistory = tournamentHistory.filter((row) => row.event_id === eventId);
		const currentEventBattles =
			includeHistory || needsHistoryForFallback ? currentEventHistory : tournamentBattles;
		const currentProjection = selectCurrentOfficialH2HProjection(
			tournament.totalTeamNum,
			tournamentGroups,
			currentEventBattles,
			tournamentHistory,
			eventId,
			activeEventId,
			finalizedEventIds
		);
		const currentEventComplete = officialH2HCurrentEventIsComplete(
			currentProjection.currentEventComplete,
			currentEventBattles,
			tournamentKnockouts,
			eventId,
			finalizedEventIds,
			tournament
		);
		const validatedFinalizedEventIds = new Set(currentProjection.options.finalizedEventIds ?? []);
		if (currentEventComplete && finalizedEventIds.has(eventId)) {
			validatedFinalizedEventIds.add(eventId);
		}
		const historicalStandings =
			eventId < activeEventId && includeHistory
				? projectHistoricalOfficialH2HStandings(
						tournamentGroups.map((row) => row.entry_id),
						tournamentHistory,
						currentProjection.options
					)
				: null;
		const projectedStandings = historicalStandings ?? currentProjection.standings;
		const matches = [
			...currentEventBattles.map((row) =>
				mapOfficialBattleMatch(row, entryNames, currentProjection.options)
			),
			...tournamentKnockouts.map((row) => mapOfficialKnockoutMatch(row, entryNames)),
		].sort(
			(left, right) =>
				left.eventId - right.eventId ||
				left.sourceOrder - right.sourceOrder ||
				left.officialMatchId - right.officialMatchId
		);
		const scoreCheckedAt =
			finalizedEventIds.has(eventId) && currentEventComplete
				? latestOfficialH2HCheckedAt(matches)
				: null;
		loaded.set(tournament.id, {
			snapshot: {
				tournament,
				eventId,
				awaitingSchedule:
					tournament.officialScheduleLockedAt === null ||
					tournament.officialScheduleLockedAt === undefined,
				scoreSource: scoreCheckedAt ? "FPL_H2H_FINAL" : "UNAVAILABLE",
				scoreRevision: scoreCheckedAt ? `fpl-h2h:${eventId}:${scoreCheckedAt}` : null,
				scoreCheckedAt,
				standings: projectedStandings
					? projectedStandings.map((row) => ({
							...row,
							entryName: entryNames.get(row.entryId)?.entry_name ?? null,
							playerName: entryNames.get(row.entryId)?.player_name ?? null,
						}))
					: tournamentGroups.map((row) => ({
							entryId: row.entry_id,
							entryName: entryNames.get(row.entry_id)?.entry_name ?? null,
							playerName: entryNames.get(row.entry_id)?.player_name ?? null,
							rank: row.group_rank,
							matchPoints: row.group_points ?? 0,
							played: row.played ?? 0,
							won: row.won ?? 0,
							drawn: row.drawn ?? 0,
							lost: row.lost ?? 0,
							pointsFor: row.total_net_points ?? 0,
						})),
				matches,
			},
			history: tournamentHistory,
			standingsPublished: currentEventComplete || currentProjection.storedPlayed > 0,
			currentEventComplete,
			validatedFinalizedEventIds,
		});
	}
	return loaded;
}

export type EventLiveH2HScoreBatch = {
	scores: ReadonlyMap<number, number>;
	managerRevisions: ReadonlyMap<number, string>;
	revision: string;
	checkedAt: string;
	state: "scheduled" | "live" | "settled";
	/** Shared source identity used when several bounded chunks form one round. */
	livePublicationId?: string | null;
	snapshotRevision?: string | null;
};

const latestOfficialH2HCheckedAt = (matches: readonly OfficialH2HMatch[]): string | null =>
	matches
		.map((match) => match.sourceCheckedAt)
		.filter((value): value is string => Boolean(value))
		.sort()
		.at(-1) ?? null;

function rejectedFinalizedOfficialH2HEventIds(
	finalizedEventIds: ReadonlySet<number>,
	validatedFinalizedEventIds: ReadonlySet<number>
): Set<number> {
	return new Set(
		[...finalizedEventIds].filter((eventId) => !validatedFinalizedEventIds.has(eventId))
	);
}

function officialKnockoutMatchesHaveCompleteSchedule(
	matches: readonly OfficialH2HMatch[],
	eventId: number,
	tournament: OfficialKnockoutRoundConfig
): boolean {
	const rows = matches.filter((match) => match.eventId === eventId && match.phase === "KNOCKOUT");
	if (rows.length === 0) return false;
	const matchIds = new Set<number>();
	const sourceOrders = new Set<number>();
	const scheduledEntryIds = new Set<number>();
	let expectedRound: number | null = null;
	let expectedMatches: number | null = null;
	for (const row of rows) {
		const bracket = expectedOfficialKnockoutMatches(tournament, eventId, row.knockoutName);
		if (
			!bracket ||
			(expectedRound !== null && expectedRound !== bracket.round) ||
			(expectedMatches !== null && expectedMatches !== bracket.matches)
		) {
			return false;
		}
		expectedRound = bracket.round;
		expectedMatches = bracket.matches;
		if (matchIds.has(row.officialMatchId) || sourceOrders.has(row.sourceOrder)) return false;
		matchIds.add(row.officialMatchId);
		sourceOrders.add(row.sourceOrder);
		const sides = [row.home.entryId, row.away.entryId].filter(
			(entryId): entryId is number => entryId !== null
		);
		if (sides.length === 0 || new Set(sides).size !== sides.length) return false;
		if (sides.some((entryId) => scheduledEntryIds.has(entryId))) return false;
		for (const entryId of sides) scheduledEntryIds.add(entryId);
	}
	return expectedMatches === rows.length;
}

function activeOfficialH2HScoreEntryIds(
	loaded: OfficialH2HSnapshotLoad,
	eventId: number
): number[] {
	return [
		...new Set(
			loaded.snapshot.matches
				.filter((match) => match.eventId === eventId)
				.flatMap((match) => [match.home.entryId, match.away.entryId])
				.filter((entryId): entryId is number => entryId !== null)
		),
	];
}

function tournamentEventLiveScoreRevision(
	loaded: OfficialH2HSnapshotLoad,
	eventId: number,
	batch: EventLiveH2HScoreBatch
): string {
	const entryScores = activeOfficialH2HScoreEntryIds(loaded, eventId)
		.sort((left, right) => left - right)
		.map((entryId) => ({
			entryId,
			score: batch.scores.get(entryId) ?? null,
			managerRevision: batch.managerRevisions.get(entryId) ?? null,
		}));
	const revisionHash = createHash("sha256")
		.update(
			stableStringify({
				eventId,
				livePublicationId: batch.livePublicationId ?? null,
				snapshotRevision: batch.snapshotRevision ?? null,
				checkedAt: batch.checkedAt,
				state: batch.state,
				entryScores,
			}),
			"utf8"
		)
		.digest("hex")
		.slice(0, 24);
	return `event-live-h2h:${eventId}:${revisionHash}`;
}

function suppressActiveOfficialH2HScores(
	loaded: OfficialH2HSnapshotLoad,
	eventId: number,
	finalizedEventIds: ReadonlySet<number>
): OfficialH2HSnapshotLoad {
	if (finalizedEventIds.has(eventId)) {
		const scoreCheckedAt = latestOfficialH2HCheckedAt(loaded.snapshot.matches);
		if (!loaded.currentEventComplete || !scoreCheckedAt) {
			return suppressActiveOfficialH2HScores(
				loaded,
				eventId,
				new Set([...finalizedEventIds].filter((candidate) => candidate !== eventId))
			);
		}
		return {
			...loaded,
			snapshot: {
				...loaded.snapshot,
				scoreSource: "FPL_H2H_FINAL",
				scoreRevision: scoreCheckedAt ? `fpl-h2h:${eventId}:${scoreCheckedAt}` : null,
				scoreCheckedAt,
			},
		};
	}

	const entryIds = loaded.snapshot.standings.map((standing) => standing.entryId);
	const standingIdentity = new Map(
		loaded.snapshot.standings.map((standing) => [standing.entryId, standing] as const)
	);
	const projected = projectOfficialH2HStandingsFromResults(entryIds, loaded.history, {
		finalizedEventIds: loaded.validatedFinalizedEventIds,
		suppressedEventIds: new Set([
			eventId,
			...rejectedFinalizedOfficialH2HEventIds(finalizedEventIds, loaded.validatedFinalizedEventIds),
		]),
	});
	return {
		...loaded,
		standingsPublished: projected.some((standing) => standing.played > 0),
		currentEventComplete: false,
		snapshot: {
			...loaded.snapshot,
			scoreSource: "UNAVAILABLE",
			scoreRevision: null,
			scoreCheckedAt: null,
			standings: projected.map((standing) => ({
				...standing,
				entryName: standingIdentity.get(standing.entryId)?.entryName ?? null,
				playerName: standingIdentity.get(standing.entryId)?.playerName ?? null,
			})),
			matches: loaded.snapshot.matches.map((match) =>
				match.eventId !== eventId
					? match
					: {
							...match,
							home: { ...match.home, points: null, matchPoints: null },
							away: { ...match.away, points: null, matchPoints: null },
							winnerEntryId: null,
							sourceCheckedAt: null,
						}
			),
		},
	};
}

/**
 * Overlay one active H2H round with manager net scores derived from the same
 * revisioned event-live player snapshot. The official H2H feed remains the
 * schedule authority; it is never allowed to overwrite an active score.
 */
export function projectOfficialH2HEventLiveSnapshot(
	loaded: OfficialH2HSnapshotLoad,
	eventId: number,
	batch: EventLiveH2HScoreBatch,
	finalizedEventIds: ReadonlySet<number>
): OfficialH2HSnapshotLoad {
	const suppressed = suppressActiveOfficialH2HScores(loaded, eventId, finalizedEventIds);
	if (finalizedEventIds.has(eventId) || batch.state === "scheduled") return suppressed;

	const entryIds = loaded.snapshot.standings.map((standing) => standing.entryId);
	const expectedEntryCount = loaded.snapshot.tournament.totalTeamNum;
	const currentSourceRows = loaded.history.filter((row) => row.event_id === eventId);
	const scoreEntryIds = activeOfficialH2HScoreEntryIds(loaded, eventId);
	const hasRegularRound = currentSourceRows.length > 0;
	const hasCompleteKnockoutSchedule = officialKnockoutMatchesHaveCompleteSchedule(
		loaded.snapshot.matches,
		eventId,
		loaded.snapshot.tournament
	);
	if (
		!Number.isSafeInteger(expectedEntryCount) ||
		expectedEntryCount <= 0 ||
		entryIds.length !== expectedEntryCount ||
		new Set(entryIds).size !== expectedEntryCount ||
		(!hasRegularRound && !hasCompleteKnockoutSchedule) ||
		currentSourceRows.some((row) => row.home_is_average || row.away_is_average) ||
		scoreEntryIds.length === 0 ||
		scoreEntryIds.some(
			(entryId) =>
				typeof batch.scores.get(entryId) !== "number" ||
				typeof batch.managerRevisions.get(entryId) !== "string"
		)
	) {
		return suppressed;
	}

	const projectedHistory = loaded.history.map((row) => {
		if (row.event_id !== eventId) return row;
		return {
			...row,
			home_net_points:
				row.home_entry_id === null ? null : (batch.scores.get(row.home_entry_id) ?? null),
			away_net_points:
				row.away_entry_id === null ? null : (batch.scores.get(row.away_entry_id) ?? null),
			source_checked_at: batch.checkedAt,
		};
	});
	const currentRows = projectedHistory.filter((row) => row.event_id === eventId);
	const options: OfficialH2HProjectionOptions = {
		finalizedEventIds: loaded.validatedFinalizedEventIds,
		provisionalEventIds: new Set([eventId]),
		suppressedEventIds: rejectedFinalizedOfficialH2HEventIds(
			finalizedEventIds,
			loaded.validatedFinalizedEventIds
		),
		trustedEventLiveEventIds: new Set([eventId]),
	};
	if (hasRegularRound && !officialBattleRowsAreCompleteForEntries(entryIds, currentRows, options)) {
		return suppressed;
	}

	const standingIdentity = new Map(
		loaded.snapshot.standings.map((standing) => [standing.entryId, standing] as const)
	);
	const knockoutStructure = resolveOfficialKnockoutStructure(loaded.snapshot.tournament);
	const standings = projectOfficialH2HStandingsFromResults(entryIds, projectedHistory, options).map(
		(standing) => ({
			...standing,
			entryName: standingIdentity.get(standing.entryId)?.entryName ?? null,
			playerName: standingIdentity.get(standing.entryId)?.playerName ?? null,
		})
	);
	const matches = loaded.snapshot.matches.map((match) => {
		if (match.eventId !== eventId) return match;
		const homePoints =
			match.home.entryId === null ? null : (batch.scores.get(match.home.entryId) ?? null);
		const awayPoints =
			match.away.entryId === null ? null : (batch.scores.get(match.away.entryId) ?? null);
		// A multi-event knockout winner depends on the aggregate tie. This live
		// batch contains only the current event, so defer the outcome until Data
		// publishes the authoritative finalized knockout result.
		const deferKnockoutOutcome =
			match.phase === "KNOCKOUT" &&
			(knockoutStructure === null || knockoutStructure.eventsPerOpponent > 1);
		const scoreable =
			!match.isBye && !deferKnockoutOutcome && homePoints !== null && awayPoints !== null;
		const homeMatchPoints = !scoreable
			? null
			: homePoints > awayPoints
				? 3
				: homePoints < awayPoints
					? 0
					: 1;
		const awayMatchPoints =
			homeMatchPoints === null ? null : homeMatchPoints === 3 ? 0 : homeMatchPoints === 0 ? 3 : 1;
		return {
			...match,
			home: { ...match.home, points: homePoints, matchPoints: homeMatchPoints },
			away: { ...match.away, points: awayPoints, matchPoints: awayMatchPoints },
			winnerEntryId: match.isBye
				? (match.winnerEntryId ?? match.home.entryId ?? match.away.entryId)
				: homeMatchPoints === 3
					? match.home.entryId
					: awayMatchPoints === 3
						? match.away.entryId
						: null,
			sourceCheckedAt: batch.checkedAt,
		};
	});

	return {
		...loaded,
		history: projectedHistory,
		standingsPublished: true,
		currentEventComplete: true,
		snapshot: {
			...loaded.snapshot,
			scoreSource: "FPL_EVENT_LIVE",
			scoreRevision: tournamentEventLiveScoreRevision(loaded, eventId, batch),
			scoreCheckedAt: batch.checkedAt,
			standings,
			matches,
		},
	};
}

async function loadEventLiveH2HScoreBatch(
	context: GraphQLContext,
	eventId: number,
	entryIds: readonly number[]
): Promise<EventLiveH2HScoreBatch | null> {
	if (entryIds.length === 0 || entryIds.length > 500) return null;
	const result = await entryLiveBatchService.calcLivePointsForEntries(context, eventId, [
		...entryIds,
	]);
	if (result.errors.length > 0 || result.results.size !== entryIds.length) return null;

	const scores = new Map<number, number>();
	let livePublicationId: string | null = null;
	let snapshotRevision: string | null = null;
	let checkedAt: string | null = null;
	let state: EventLiveH2HScoreBatch["state"] | null = null;
	const managerRevisions = new Map<number, string>();
	for (const entryId of entryIds) {
		const row = result.results.get(entryId);
		const liveProvenance = row?.score.provenance;
		if (
			!row ||
			!isTraceableOfficialManagerScore(row.score) ||
			row.score.source !== "FPL_EVENT_LIVE" ||
			typeof row.score.netEventPoints !== "number" ||
			typeof row.score.revision !== "string" ||
			row.score.revision.trim().length === 0 ||
			!row.snapshot ||
			!liveProvenance ||
			liveProvenance.scoreSource !== "FPL_EVENT_LIVE" ||
			liveProvenance.livePublicationId === null ||
			liveProvenance.liveRevision === null ||
			liveProvenance.liveCheckedAt === null ||
			row.snapshot.revision !== liveProvenance.liveRevision ||
			row.snapshot.publicationId !== liveProvenance.livePublicationId
		) {
			return null;
		}
		if (
			(livePublicationId !== null && livePublicationId !== liveProvenance.livePublicationId) ||
			(snapshotRevision !== null && snapshotRevision !== liveProvenance.liveRevision) ||
			(checkedAt !== null && checkedAt !== liveProvenance.liveCheckedAt) ||
			(state !== null && state !== row.snapshot.state)
		) {
			return null;
		}
		livePublicationId = liveProvenance.livePublicationId;
		snapshotRevision = liveProvenance.liveRevision;
		checkedAt = liveProvenance.liveCheckedAt;
		state = row.snapshot.state;
		scores.set(entryId, row.score.netEventPoints);
		managerRevisions.set(entryId, row.score.revision);
	}
	if (!snapshotRevision || !checkedAt || !state) return null;
	const orderedManagerRevisions = [...managerRevisions]
		.sort(([left], [right]) => left - right)
		.map(([entryId, revision]) => ({ entryId, revision }));
	const revisionHash = createHash("sha256")
		.update(
			stableStringify({
				eventId,
				livePublicationId,
				snapshotRevision,
				managerRevisions: orderedManagerRevisions,
			}),
			"utf8"
		)
		.digest("hex")
		.slice(0, 24);
	return {
		scores,
		managerRevisions,
		revision: `event-live-h2h:${eventId}:${revisionHash}`,
		checkedAt,
		state,
		livePublicationId,
		snapshotRevision,
	};
}

const chunkEntryIds = (entryIds: readonly number[], size: number): number[][] => {
	const chunks: number[][] = [];
	for (let index = 0; index < entryIds.length; index += size) {
		chunks.push([...entryIds.slice(index, index + size)]);
	}
	return chunks;
};

/** Load one coherent event-live source across all active tournaments. */
async function loadEventLiveH2HScoreBatches(
	context: GraphQLContext,
	eventId: number,
	entryIds: readonly number[]
): Promise<EventLiveH2HScoreBatch | null> {
	const uniqueEntryIds = [...new Set(entryIds)].sort((left, right) => left - right);
	if (uniqueEntryIds.length === 0) return null;
	const chunks = chunkEntryIds(uniqueEntryIds, 500);
	const batches: Array<EventLiveH2HScoreBatch | null> = new Array<EventLiveH2HScoreBatch | null>(
		chunks.length
	).fill(null);
	let nextChunk = 0;
	const worker = async (): Promise<void> => {
		while (nextChunk < chunks.length) {
			const chunkIndex = nextChunk;
			nextChunk += 1;
			const chunk = chunks[chunkIndex]!;
			batches[chunkIndex] = await loadEventLiveH2HScoreBatch(context, eventId, chunk).catch(
				(error) => {
					context.logger.warn(
						{ eventId, chunkIndex, chunkSize: chunk.length, err: error },
						"Event-live H2H score chunk unavailable"
					);
					return null;
				}
			);
		}
	};
	await Promise.all(Array.from({ length: Math.min(2, chunks.length) }, () => worker()));
	if (batches.some((batch) => batch === null)) return null;
	const completeBatches = batches as EventLiveH2HScoreBatch[];
	const first = completeBatches[0];
	if (!first) return null;
	for (const batch of completeBatches.slice(1)) {
		if (
			batch.checkedAt !== first.checkedAt ||
			batch.state !== first.state ||
			batch.livePublicationId !== first.livePublicationId ||
			batch.snapshotRevision !== first.snapshotRevision
		) {
			context.logger.warn(
				{
					eventId,
					expectedRevision: first.snapshotRevision,
					observedRevision: batch.snapshotRevision,
				},
				"Event-live H2H score chunks observed mixed publication metadata"
			);
			return null;
		}
	}
	const scores = new Map<number, number>();
	const managerRevisions = new Map<number, string>();
	for (const batch of completeBatches) {
		for (const [entryId, score] of batch.scores) scores.set(entryId, score);
		for (const [entryId, revision] of batch.managerRevisions) {
			managerRevisions.set(entryId, revision);
		}
	}
	const revisionHash = createHash("sha256")
		.update(
			stableStringify({
				eventId,
				livePublicationId: first.livePublicationId,
				snapshotRevision: first.snapshotRevision,
				checkedAt: first.checkedAt,
				chunks: completeBatches.map((batch) => batch.revision),
			})
		)
		.digest("hex")
		.slice(0, 24);
	return {
		scores,
		managerRevisions,
		revision: `event-live-h2h:${eventId}:${revisionHash}`,
		checkedAt: first.checkedAt,
		state: first.state,
		livePublicationId: first.livePublicationId,
		snapshotRevision: first.snapshotRevision,
	};
}

async function applyActiveOfficialH2HScoreAuthority(
	context: GraphQLContext,
	loaded: Map<number, OfficialH2HSnapshotLoad>,
	eventId: number,
	finalizedEventIds: ReadonlySet<number>
): Promise<Map<number, OfficialH2HSnapshotLoad>> {
	if (finalizedEventIds.has(eventId)) {
		return new Map(
			[...loaded].map(([tournamentId, snapshot]) => [
				tournamentId,
				suppressActiveOfficialH2HScores(snapshot, eventId, finalizedEventIds),
			])
		);
	}

	const baselines = new Map(
		[...loaded].map(
			([tournamentId, snapshot]) =>
				[
					tournamentId,
					suppressActiveOfficialH2HScores(snapshot, eventId, finalizedEventIds),
				] as const
		)
	);
	const entryIds = [
		...new Set(
			[...loaded].flatMap(([, snapshot]) => activeOfficialH2HScoreEntryIds(snapshot, eventId))
		),
	].sort((left, right) => left - right);
	const batch = await loadEventLiveH2HScoreBatches(context, eventId, entryIds);
	if (!batch) return baselines;
	return new Map(
		[...loaded].map(
			([tournamentId, snapshot]) =>
				[
					tournamentId,
					projectOfficialH2HEventLiveSnapshot(snapshot, eventId, batch, finalizedEventIds),
				] as const
		)
	);
}

type DbTournamentEventSnapshotRow = {
	tournament_id: number;
	event_id: number;
	entry_id: number;
	tournament_overall_rank: number | null;
	overall_rank: number | null;
	team_value: number | null;
	cum_transfers_num: number | null;
	cum_total_costs: number | null;
	cum_total_bench_points: number | null;
	cum_auto_sub_points: number | null;
	tournament_team_value_rank: number | null;
	tournament_transfers_rank: number | null;
	tournament_costs_rank: number | null;
	tournament_bench_points_rank: number | null;
	tournament_auto_sub_rank: number | null;
};

const TOURNAMENT_CACHE_NAMESPACE = "tournaments:v2";

const tournamentCacheKey = (context: GraphQLContext, suffix: string): string =>
	gqlCacheKey(context, `${TOURNAMENT_CACHE_NAMESPACE}:${suffix}`);

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
	Object.prototype.hasOwnProperty.call(value, key);

const GRAPHQL_INT_MIN = -2_147_483_648;
const GRAPHQL_INT_MAX = 2_147_483_647;

const isSafeInteger = (value: unknown): value is number =>
	typeof value === "number" &&
	Number.isSafeInteger(value) &&
	value >= GRAPHQL_INT_MIN &&
	value <= GRAPHQL_INT_MAX;

const isFiniteNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

const normalizeDatabaseNumber = (value: unknown): number | null => {
	if (value === null || value === undefined || value === "") return null;
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : null;
};

const normalizeDatabaseInteger = (value: unknown): number | null => {
	const parsed = normalizeDatabaseNumber(value);
	return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
};

const isNullableSafeInteger = (value: unknown): value is number | null =>
	value === null || isSafeInteger(value);

const isNullableFiniteNumber = (value: unknown): value is number | null =>
	value === null || isFiniteNumber(value);

const isNullableString = (value: unknown): value is string | null =>
	value === null || typeof value === "string";

const normalizeTournamentChip = (value: unknown): string | null =>
	normalizeFplChip(value, null, { emptyAsNone: false });

const isNullableChip = (value: unknown): value is string | null =>
	value === null || normalizeTournamentChip(value) === value;

const isIsoDateTime = (value: unknown): value is string => {
	if (typeof value !== "string") return false;
	const match =
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(
			value
		);
	if (!match) return false;
	const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const hour = Number(hourText);
	const minute = Number(minuteText);
	const second = Number(secondText);
	const offsetHours = zone === "Z" ? 0 : Number(zone.slice(1, 3));
	const offsetMinutes = zone === "Z" ? 0 : Number(zone.slice(4, 6));
	const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
	return (
		month >= 1 &&
		month <= 12 &&
		day >= 1 &&
		day <= daysInMonth &&
		hour >= 0 &&
		hour <= 23 &&
		minute >= 0 &&
		minute <= 59 &&
		second >= 0 &&
		second <= 59 &&
		offsetHours <= 23 &&
		offsetMinutes <= 59 &&
		Number.isFinite(Date.parse(value))
	);
};

const isNullableIsoDateTime = (value: unknown): value is string | null =>
	value === null || isIsoDateTime(value);

const isEnumValue = <T extends string>(enumObject: Record<string, T>, value: unknown): value is T =>
	typeof value === "string" && Object.values(enumObject).includes(value as T);

const isRequired = (
	value: Record<string, unknown>,
	key: string,
	predicate: (candidate: unknown) => boolean
): boolean => hasOwn(value, key) && predicate(value[key]);

const isTournamentSetupWarningSummaryCache = (
	value: unknown
): value is TournamentSetupWarningSummary =>
	isRecord(value) &&
	isRequired(value, "category", (candidate) =>
		isEnumValue(TournamentSetupWarningCategory, candidate)
	) &&
	isRequired(value, "affectedCount", isSafeInteger) &&
	isRequired(value, "repairExhausted", (candidate) => typeof candidate === "boolean");

const isTournamentInfoCache = (value: unknown): value is TournamentInfo => {
	if (!isRecord(value)) return false;
	return (
		isRequired(value, "id", (candidate) => isSafeInteger(candidate)) &&
		isRequired(value, "name", (candidate) => typeof candidate === "string") &&
		isRequired(value, "creator", (candidate) => typeof candidate === "string") &&
		isRequired(value, "adminEntryId", (candidate) => isSafeInteger(candidate)) &&
		isRequired(value, "leagueId", (candidate) => isSafeInteger(candidate)) &&
		isRequired(value, "leagueType", (candidate) => isEnumValue(LeagueType, candidate)) &&
		isRequired(value, "sourceLeagueName", isNullableString) &&
		isRequired(value, "rosterMode", (candidate) => isEnumValue(TournamentRosterMode, candidate)) &&
		isRequired(
			value,
			"rosterSyncStatus",
			(candidate) => candidate === null || isEnumValue(TournamentSetupStatus, candidate)
		) &&
		isRequired(value, "rosterLastSyncedAt", isNullableIsoDateTime) &&
		isRequired(value, "officialScheduleHash", isNullableString) &&
		isRequired(value, "officialScheduleSyncedAt", isNullableIsoDateTime) &&
		isRequired(value, "officialScheduleLockedAt", isNullableIsoDateTime) &&
		isRequired(value, "totalTeamNum", (candidate) => isSafeInteger(candidate)) &&
		isRequired(value, "tournamentMode", (candidate) => isEnumValue(TournamentMode, candidate)) &&
		isRequired(
			value,
			"groupMode",
			(candidate) => candidate === null || isEnumValue(GroupMode, candidate)
		) &&
		isRequired(value, "groupTeamNum", isNullableSafeInteger) &&
		isRequired(value, "groupNum", isNullableSafeInteger) &&
		isRequired(value, "groupStartedEventId", isNullableSafeInteger) &&
		isRequired(value, "groupEndedEventId", isNullableSafeInteger) &&
		isRequired(value, "groupAutoAverages", (candidate) => typeof candidate === "boolean") &&
		isRequired(value, "groupRounds", isNullableSafeInteger) &&
		isRequired(value, "groupPlayAgainstNum", isNullableSafeInteger) &&
		isRequired(value, "groupQualifyNum", isNullableSafeInteger) &&
		isRequired(
			value,
			"knockoutMode",
			(candidate) => candidate === null || isEnumValue(KnockoutMode, candidate)
		) &&
		isRequired(value, "knockoutTeamNum", isNullableSafeInteger) &&
		isRequired(value, "knockoutRounds", isNullableSafeInteger) &&
		isRequired(value, "knockoutEventNum", isNullableSafeInteger) &&
		isRequired(value, "knockoutStartedEventId", isNullableSafeInteger) &&
		isRequired(value, "knockoutEndedEventId", isNullableSafeInteger) &&
		isRequired(value, "knockoutPlayAgainstNum", isNullableSafeInteger) &&
		isRequired(value, "state", (candidate) => isEnumValue(TournamentState, candidate)) &&
		isRequired(value, "setupStatus", (candidate) =>
			isEnumValue(TournamentSetupStatus, candidate)
		) &&
		isRequired(value, "setupPhase", (candidate) => isEnumValue(TournamentSetupPhase, candidate)) &&
		isRequired(value, "setupCompletedUnits", (candidate) => isSafeInteger(candidate)) &&
		isRequired(value, "setupTotalUnits", (candidate) => isSafeInteger(candidate)) &&
		isRequired(value, "setupProgressUpdatedAt", isNullableIsoDateTime) &&
		isRequired(value, "setupProgressMode", (candidate) =>
			isEnumValue(TournamentSetupProgressMode, candidate)
		) &&
		isRequired(value, "setupAttempt", isSafeInteger) &&
		isRequired(value, "setupMaxAttempts", isSafeInteger) &&
		isRequired(value, "nextRetryAt", isNullableIsoDateTime) &&
		isRequired(value, "standingsReadyAt", isNullableIsoDateTime) &&
		isRequired(value, "profilesReadyAt", isNullableIsoDateTime) &&
		isRequired(value, "insightsReadyAt", isNullableIsoDateTime) &&
		isRequired(value, "setupHasWarnings", (candidate) => typeof candidate === "boolean") &&
		isRequired(value, "setupStartedAt", isNullableIsoDateTime) &&
		isRequired(value, "setupFinishedAt", isNullableIsoDateTime) &&
		isRequired(value, "createdAt", isIsoDateTime) &&
		isRequired(value, "updatedAt", isIsoDateTime)
	);
};

const isTournamentInfoArrayCache = (value: unknown): value is TournamentInfo[] =>
	Array.isArray(value) &&
	value.every(
		(item) =>
			isTournamentInfoCache(item) &&
			isRequired(
				item,
				"warningSummaries",
				(candidate) =>
					Array.isArray(candidate) && candidate.every(isTournamentSetupWarningSummaryCache)
			)
	);

const isEntryIdArrayCache = (value: unknown): value is number[] =>
	Array.isArray(value) && value.every((item) => isSafeInteger(item) && item > 0);

const isTournamentEventResultCache = (value: unknown): value is TournamentEventResult => {
	if (!isRecord(value)) return false;
	return (
		isRequired(value, "tournament", isTournamentInfoCache) &&
		isRequired(value, "eventId", isSafeInteger) &&
		isRequired(value, "groupId", isSafeInteger) &&
		isRequired(value, "entryId", isSafeInteger) &&
		isRequired(value, "entryName", isNullableString) &&
		isRequired(value, "playerName", isNullableString) &&
		isRequired(value, "eventGroupRank", isNullableSafeInteger) &&
		isRequired(value, "eventPoints", isNullableSafeInteger) &&
		isRequired(value, "eventCost", isNullableSafeInteger) &&
		isRequired(value, "eventNetPoints", isNullableSafeInteger) &&
		isRequired(value, "eventRank", isNullableSafeInteger) &&
		isRequired(value, "overallPoints", isNullableSafeInteger) &&
		isRequired(value, "overallRank", isNullableSafeInteger) &&
		isRequired(value, "eventChip", isNullableChip) &&
		isRequired(value, "captainId", isNullableSafeInteger) &&
		isRequired(value, "captainPoints", isNullableSafeInteger) &&
		isRequired(value, "teamValue", isNullableSafeInteger) &&
		isRequired(value, "bank", isNullableSafeInteger)
	);
};

const isTournamentEventResultArrayCache = (value: unknown): value is TournamentEventResult[] =>
	Array.isArray(value) && value.every(isTournamentEventResultCache);

const isRankingSummaryCache = (value: unknown): value is TournamentEntryRankingSummary => {
	if (!isRecord(value)) return false;
	const integerFields = ["eventId", "entryId"];
	const nullableNumberFields = [
		"overallRank",
		"tournamentOverallRank",
		"teamValue",
		"tournamentTeamValueRank",
		"transfersNum",
		"tournamentTransfersRank",
		"totalCosts",
		"tournamentCostsRank",
		"totalBenchPoints",
		"tournamentBenchPointsRank",
		"autoSubPoints",
		"tournamentAutoSubRank",
		"overallPoints",
		"leaderOverallPoints",
		"gapToLeader",
		"pointsBehindNext",
		"pointsAheadOfPrev",
	];
	return (
		integerFields.every((key) => isRequired(value, key, isSafeInteger)) &&
		nullableNumberFields.every((key) => isRequired(value, key, isNullableSafeInteger))
	);
};

const isBattleResultCache = (value: unknown): value is TournamentBattleGroupResult => {
	if (!isRecord(value)) return false;
	return (
		isRequired(value, "tournament", isTournamentInfoCache) &&
		isRequired(value, "matchId", isSafeInteger) &&
		isRequired(value, "groupId", isSafeInteger) &&
		isRequired(value, "eventId", isSafeInteger) &&
		isRequired(value, "homeEntryId", isSafeInteger) &&
		isRequired(value, "homeEntryName", isNullableString) &&
		isRequired(value, "homePlayerName", isNullableString) &&
		isRequired(value, "homeNetPoints", isNullableSafeInteger) &&
		isRequired(value, "homeRank", isNullableSafeInteger) &&
		isRequired(value, "homeMatchPoints", isNullableSafeInteger) &&
		isRequired(value, "awayEntryId", isSafeInteger) &&
		isRequired(value, "awayEntryName", isNullableString) &&
		isRequired(value, "awayPlayerName", isNullableString) &&
		isRequired(value, "awayNetPoints", isNullableSafeInteger) &&
		isRequired(value, "awayRank", isNullableSafeInteger) &&
		isRequired(value, "awayMatchPoints", isNullableSafeInteger)
	);
};

const isBattleResultArrayCache = (value: unknown): value is TournamentBattleGroupResult[] =>
	Array.isArray(value) && value.every(isBattleResultCache);

const isH2HResultCache = (value: unknown): value is EntryH2HMatchResult => {
	if (!isRecord(value)) return false;
	return (
		isRequired(value, "tournament", isTournamentInfoCache) &&
		["matchId", "groupId", "eventId", "entryId", "opponentEntryId"].every((key) =>
			isRequired(value, key, isSafeInteger)
		) &&
		[
			"entryName",
			"playerName",
			"opponentEntryName",
			"opponentPlayerName",
			"entryChip",
			"opponentChip",
		].every((key) =>
			isRequired(value, key, (candidate) =>
				["entryChip", "opponentChip"].includes(key)
					? isNullableChip(candidate)
					: isNullableString(candidate)
			)
		) &&
		[
			"entryNetPoints",
			"entryRank",
			"entryMatchPoints",
			"entryEventPoints",
			"entryTransferCost",
			"entryOverallRank",
			"opponentNetPoints",
			"opponentRank",
			"opponentMatchPoints",
			"opponentEventPoints",
			"opponentTransferCost",
			"opponentOverallRank",
		].every((key) => isRequired(value, key, isNullableSafeInteger))
	);
};

const isH2HResultArrayCache = (value: unknown): value is EntryH2HMatchResult[] =>
	Array.isArray(value) && value.every(isH2HResultCache);

const TOURNAMENT_INFO_COLUMNS =
	"id, name, creator, admin_entry_id, league_id, league_type, source_league_name, roster_mode, roster_sync_status, roster_last_synced_at, official_schedule_hash, official_schedule_synced_at, official_schedule_locked_at, total_team_num, tournament_mode, group_mode, group_team_num, group_num, group_started_event_id, group_ended_event_id, group_auto_averages, group_rounds, group_play_against_num, group_qualify_num, knockout_mode, knockout_team_num, knockout_rounds, knockout_event_num, knockout_started_event_id, knockout_ended_event_id, knockout_play_against_num, state, setup_status, setup_phase, setup_completed_units, setup_total_units, setup_progress_updated_at, setup_progress_indeterminate, setup_attempt, setup_max_attempts, setup_next_retry_at, standings_ready_at, profiles_ready_at, insights_ready_at, setup_warning_count, setup_started_at, setup_finished_at, created_at, updated_at";

const TOURNAMENT_VIEW_COLUMNS =
	"tournament_id, event_id, entry_id, group_id, event_group_rank, event_points, event_cost, event_net_points, event_rank, overall_points, overall_rank, event_chip, captain_id, captain_points, team_value, bank, entry_name, player_name, _tournament_id, _tournament_name, _tournament_creator, _tournament_admin_entry_id, _tournament_league_id, _tournament_league_type, _tournament_total_team_num, _tournament_tournament_mode, _tournament_group_mode, _tournament_group_team_num, _tournament_group_num, _tournament_group_started_event_id, _tournament_group_ended_event_id, _tournament_group_auto_averages, _tournament_group_rounds, _tournament_group_play_against_num, _tournament_group_qualify_num, _tournament_knockout_mode, _tournament_knockout_team_num, _tournament_knockout_rounds, _tournament_knockout_event_num, _tournament_knockout_started_event_id, _tournament_knockout_ended_event_id, _tournament_knockout_play_against_num, _tournament_state, _tournament_created_at, _tournament_updated_at";

const mapLeagueType = (type: string): LeagueType => {
	return type === LeagueType.H2H ? LeagueType.H2H : LeagueType.CLASSIC;
};

const mapTournamentMode = (mode: string): TournamentMode => {
	if (mode === TournamentMode.NORMAL) {
		return TournamentMode.NORMAL;
	}
	throw new Error(`Unknown tournament mode: ${mode}`);
};

const mapGroupMode = (mode: string | null): GroupMode | null => {
	if (mode === null) {
		return null;
	}
	if (mode === GroupMode.POINTS_RACES) {
		return GroupMode.POINTS_RACES;
	}
	if (mode === GroupMode.BATTLE_RACES) {
		return GroupMode.BATTLE_RACES;
	}
	if (mode === GroupMode.NO_GROUP) {
		return GroupMode.NO_GROUP;
	}
	throw new Error(`Unknown group mode: ${mode}`);
};

const mapKnockoutMode = (mode: string | null): KnockoutMode | null => {
	if (mode === null) {
		return null;
	}
	if (mode === KnockoutMode.SINGLE_ELIMINATION) {
		return KnockoutMode.SINGLE_ELIMINATION;
	}
	if (mode === KnockoutMode.DOUBLE_ELIMINATION) {
		return KnockoutMode.DOUBLE_ELIMINATION;
	}
	if (mode === KnockoutMode.HEAD_TO_HEAD) {
		return KnockoutMode.HEAD_TO_HEAD;
	}
	if (mode === KnockoutMode.NO_KNOCKOUT) {
		return KnockoutMode.NO_KNOCKOUT;
	}
	throw new Error(`Unknown knockout mode: ${mode}`);
};

const mapTournamentState = (state: string): TournamentState => {
	if (state === TournamentState.INACTIVE) {
		return TournamentState.INACTIVE;
	}
	if (state === TournamentState.FINISHED) {
		return TournamentState.FINISHED;
	}
	if (state === TournamentState.ACTIVE) {
		return TournamentState.ACTIVE;
	}
	throw new Error(`Unknown tournament state: ${state}`);
};

const mapTournamentSetupStatus = (status: string): TournamentSetupStatus => {
	if (status === TournamentSetupStatus.PENDING) return TournamentSetupStatus.PENDING;
	if (status === TournamentSetupStatus.PROCESSING) return TournamentSetupStatus.PROCESSING;
	if (status === TournamentSetupStatus.FAILED) return TournamentSetupStatus.FAILED;
	if (status === TournamentSetupStatus.READY) return TournamentSetupStatus.READY;
	throw new Error(`Unknown tournament setup status: ${status}`);
};

const mapTournamentSetupPhase = (phase: string | null | undefined): TournamentSetupPhase => {
	switch (phase) {
		case TournamentSetupPhase.QUEUED:
			return TournamentSetupPhase.QUEUED;
		case TournamentSetupPhase.SYNCING_ENTRIES:
			return TournamentSetupPhase.SYNCING_ENTRIES;
		case TournamentSetupPhase.BUILDING_STRUCTURE:
			return TournamentSetupPhase.BUILDING_STRUCTURE;
		case TournamentSetupPhase.CALCULATING_STANDINGS:
			return TournamentSetupPhase.CALCULATING_STANDINGS;
		case TournamentSetupPhase.ENRICHING_HISTORY:
			return TournamentSetupPhase.ENRICHING_HISTORY;
		case TournamentSetupPhase.FINALIZING:
			return TournamentSetupPhase.FINALIZING;
		case TournamentSetupPhase.FAILED:
			return TournamentSetupPhase.FAILED;
		default:
			return TournamentSetupPhase.READY;
	}
};

const mapTournamentRosterMode = (mode: string | null | undefined): TournamentRosterMode =>
	mode === TournamentRosterMode.OFFICIAL_SYNC
		? TournamentRosterMode.OFFICIAL_SYNC
		: TournamentRosterMode.SNAPSHOT;

/**
 * The Data client may decode PostgreSQL timestamptz columns as Date objects,
 * while the GraphQL DateTime scalar only accepts an ISO-8601 string. Keep the
 * conversion at the repository boundary so every tournament read has the same
 * wire representation (and never leaks Date#toString()).
 */
const toIsoDateTime = (value: unknown): string => {
	if (value === null || value === undefined || value === "") {
		throw new Error("Tournament date-time is missing");
	}
	const date = value instanceof Date ? value : new Date(String(value));
	if (Number.isNaN(date.getTime())) {
		throw new Error(`Invalid tournament date-time: ${String(value)}`);
	}
	return date.toISOString();
};

const toNullableIsoDateTime = (value: unknown): string | null =>
	value === null || value === undefined || value === "" ? null : toIsoDateTime(value);

type DbTournamentSetupIssueRow = {
	issue_key: string;
	code: string;
	diagnostic_code: string | null;
	category: string;
	severity: string;
	event_id: number | null;
	affected_entry_ids: number[] | null;
	affected_entry_count: number | null;
	repair_attempts: number | null;
	next_repair_at: DbDateTime | null;
	repair_exhausted_at: DbDateTime | null;
};

function mapSetupIssueCategory(value: string): TournamentSetupWarningCategory {
	if (value === TournamentSetupWarningCategory.INSIGHTS)
		return TournamentSetupWarningCategory.INSIGHTS;
	if (value === TournamentSetupWarningCategory.RESULTS)
		return TournamentSetupWarningCategory.RESULTS;
	return TournamentSetupWarningCategory.PROFILES;
}

function mapSetupIssueSeverity(value: string): TournamentSetupIssueSeverity {
	return value === TournamentSetupIssueSeverity.BLOCKING
		? TournamentSetupIssueSeverity.BLOCKING
		: TournamentSetupIssueSeverity.WARNING;
}

function mapTournamentSetupIssue(row: DbTournamentSetupIssueRow): TournamentSetupIssueDiagnostic {
	return {
		issueKey: row.issue_key,
		code: row.code,
		diagnosticCode: row.diagnostic_code ?? null,
		category: mapSetupIssueCategory(row.category),
		severity: mapSetupIssueSeverity(row.severity),
		eventId: row.event_id ?? null,
		affectedEntryIds: Array.isArray(row.affected_entry_ids)
			? row.affected_entry_ids.filter((id) => Number.isSafeInteger(id) && id > 0)
			: [],
		affectedCount: Number(row.affected_entry_count ?? 0),
		repairAttempts: Number(row.repair_attempts ?? 0),
		nextRepairAt: toNullableIsoDateTime(row.next_repair_at),
		repairExhausted: row.repair_exhausted_at !== null,
	};
}

export async function getTournamentSetupIssueDiagnostics(
	context: GraphQLContext,
	tournamentId: number
): Promise<TournamentSetupIssueDiagnostic[]> {
	const result = await context.data
		.read<DbTournamentSetupIssueRow>("competition.tournament_setup_issues")
		.select(
			"issue_key, code, diagnostic_code, category, severity, event_id, affected_entry_ids, affected_entry_count, repair_attempts, next_repair_at, repair_exhausted_at"
		)
		.eq("tournament_id", tournamentId)
		.is("resolved_at", null)
		.order("issue_key", { ascending: true });
	if (result.error) {
		context.logger.warn(
			{ err: result.error, tournamentId },
			"Failed to load setup issue diagnostics"
		);
		return [];
	}
	return ((result.data as DbTournamentSetupIssueRow[] | null) ?? []).map(mapTournamentSetupIssue);
}

const summarizeTournamentSetupIssues = (
	issues: readonly TournamentSetupIssueDiagnostic[]
): TournamentSetupWarningSummary[] => {
	const totals = new Map<
		TournamentSetupWarningCategory,
		{
			affectedEntryIds: Set<number>;
			fallbackCount: number;
			repairExhausted: boolean;
		}
	>();
	for (const issue of issues) {
		if (issue.severity !== TournamentSetupIssueSeverity.WARNING) continue;
		const total = totals.get(issue.category) ?? {
			affectedEntryIds: new Set<number>(),
			fallbackCount: 0,
			repairExhausted: true,
		};
		for (const entryId of issue.affectedEntryIds) total.affectedEntryIds.add(entryId);
		total.fallbackCount = Math.max(total.fallbackCount, issue.affectedCount);
		total.repairExhausted = total.repairExhausted && issue.repairExhausted;
		totals.set(issue.category, total);
	}
	return [...totals.entries()]
		.map(([category, total]) => ({
			category,
			affectedCount: Math.max(total.affectedEntryIds.size, total.fallbackCount),
			repairExhausted: total.repairExhausted,
		}))
		.sort((left, right) => left.category.localeCompare(right.category));
};

export async function getTournamentSetupWarningSummaries(
	context: GraphQLContext,
	tournamentId: number
): Promise<TournamentSetupWarningSummary[]> {
	const diagnostics = await getTournamentSetupIssueDiagnostics(context, tournamentId);
	return summarizeTournamentSetupIssues(diagnostics);
}

type DbTournamentSetupWarningSummaryRow = {
	tournament_id: number;
	category: string;
	severity: string;
	affected_entry_ids: number[] | null;
	affected_entry_count: number | null;
	repair_exhausted_at: DbDateTime | null;
};

const getTournamentSetupWarningSummariesByTournamentIds = async (
	context: GraphQLContext,
	tournamentIds: readonly number[]
): Promise<Map<number, TournamentSetupWarningSummary[]>> => {
	const uniqueIds = [...new Set(tournamentIds)];
	const summaries = new Map<number, TournamentSetupWarningSummary[]>();
	if (uniqueIds.length === 0) return summaries;

	const result = await context.data
		.read<DbTournamentSetupWarningSummaryRow>("competition.tournament_setup_issues")
		.select(
			"tournament_id, category, severity, affected_entry_ids, affected_entry_count, repair_exhausted_at"
		)
		.in("tournament_id", uniqueIds)
		.is("resolved_at", null)
		.order("tournament_id", { ascending: true });
	if (result.error) {
		context.logger.warn(
			{ err: result.error, tournamentCount: uniqueIds.length },
			"Failed to load tournament setup warning summaries"
		);
		throw new Error("Failed to load tournament setup warning summaries");
	}

	const issuesByTournament = new Map<number, TournamentSetupIssueDiagnostic[]>();
	for (const row of (result.data as DbTournamentSetupWarningSummaryRow[] | null) ?? []) {
		const issues = issuesByTournament.get(row.tournament_id) ?? [];
		issues.push({
			issueKey: "",
			code: "",
			diagnosticCode: null,
			category: mapSetupIssueCategory(row.category),
			severity: mapSetupIssueSeverity(row.severity),
			eventId: null,
			affectedEntryIds: Array.isArray(row.affected_entry_ids)
				? row.affected_entry_ids.filter((id) => Number.isSafeInteger(id) && id > 0)
				: [],
			affectedCount: Number(row.affected_entry_count ?? 0),
			repairAttempts: 0,
			nextRepairAt: null,
			repairExhausted: row.repair_exhausted_at !== null && row.repair_exhausted_at !== undefined,
		});
		issuesByTournament.set(row.tournament_id, issues);
	}
	for (const tournamentId of uniqueIds) {
		summaries.set(
			tournamentId,
			summarizeTournamentSetupIssues(issuesByTournament.get(tournamentId) ?? [])
		);
	}
	return summaries;
};

export const extractTournamentIds = (
	rows: readonly { tournament_id: number | null }[]
): number[] => {
	const unique = new Set<number>();
	rows.forEach((row) => {
		if (Number.isSafeInteger(row.tournament_id) && Number(row.tournament_id) > 0) {
			unique.add(Number(row.tournament_id));
		}
	});
	return [...unique];
};

export const mapTournamentInfo = (row: DbTournamentInfoRow): TournamentInfo => ({
	id: row.id,
	name: row.name,
	creator: row.creator,
	adminEntryId: row.admin_entry_id,
	leagueId: row.league_id,
	leagueType: mapLeagueType(row.league_type),
	sourceLeagueName: row.source_league_name ?? null,
	rosterMode: mapTournamentRosterMode(row.roster_mode),
	rosterSyncStatus: row.roster_sync_status
		? mapTournamentSetupStatus(row.roster_sync_status)
		: null,
	rosterLastSyncedAt: toNullableIsoDateTime(row.roster_last_synced_at),
	officialScheduleHash: row.official_schedule_hash ?? null,
	officialScheduleSyncedAt: toNullableIsoDateTime(row.official_schedule_synced_at),
	officialScheduleLockedAt: toNullableIsoDateTime(row.official_schedule_locked_at),
	totalTeamNum: row.total_team_num,
	tournamentMode: mapTournamentMode(row.tournament_mode),
	groupMode: mapGroupMode(row.group_mode),
	groupTeamNum: row.group_team_num,
	groupNum: row.group_num,
	groupStartedEventId: row.group_started_event_id,
	groupEndedEventId: row.group_ended_event_id,
	groupAutoAverages: row.group_auto_averages,
	groupRounds: row.group_rounds,
	groupPlayAgainstNum: row.group_play_against_num,
	groupQualifyNum: row.group_qualify_num,
	knockoutMode: mapKnockoutMode(row.knockout_mode),
	knockoutTeamNum: row.knockout_team_num,
	knockoutRounds: row.knockout_rounds,
	knockoutEventNum: row.knockout_event_num,
	knockoutStartedEventId: row.knockout_started_event_id,
	knockoutEndedEventId: row.knockout_ended_event_id,
	knockoutPlayAgainstNum: row.knockout_play_against_num,
	state: mapTournamentState(row.state),
	setupStatus: mapTournamentSetupStatus(row.setup_status),
	setupPhase: mapTournamentSetupPhase(row.setup_phase),
	setupCompletedUnits: row.setup_completed_units ?? 0,
	setupTotalUnits: row.setup_total_units ?? 0,
	setupProgressUpdatedAt: toNullableIsoDateTime(row.setup_progress_updated_at),
	setupProgressMode: row.setup_progress_indeterminate
		? TournamentSetupProgressMode.INDETERMINATE
		: TournamentSetupProgressMode.DETERMINATE,
	setupAttempt: row.setup_attempt ?? 0,
	setupMaxAttempts: row.setup_max_attempts ?? 3,
	nextRetryAt: toNullableIsoDateTime(row.setup_next_retry_at),
	standingsReadyAt: toNullableIsoDateTime(row.standings_ready_at),
	profilesReadyAt: toNullableIsoDateTime(row.profiles_ready_at),
	insightsReadyAt: toNullableIsoDateTime(row.insights_ready_at),
	setupHasWarnings: (row.setup_warning_count ?? 0) > 0,
	setupStartedAt: toNullableIsoDateTime(row.setup_started_at),
	setupFinishedAt: toNullableIsoDateTime(row.setup_finished_at),
	createdAt: toIsoDateTime(row.created_at),
	updatedAt: toIsoDateTime(row.updated_at),
});

export const mapTournamentEventResult = (
	tournament: TournamentInfo,
	row: DbTournamentPointsGroupResultRow,
	leagueEventRow?: DbLeagueEventResultEnrichmentRow | null,
	entryInfoRow?: DbEntryInfoNameRow | null
): TournamentEventResult => ({
	tournament,
	eventId: row.event_id,
	groupId: row.group_id,
	entryId: row.entry_id,
	entryName: leagueEventRow?.entry_name ?? entryInfoRow?.entry_name ?? null,
	playerName: leagueEventRow?.player_name ?? entryInfoRow?.player_name ?? null,
	eventGroupRank: row.event_group_rank,
	eventPoints: row.event_points,
	eventCost: row.event_cost,
	eventNetPoints: row.event_net_points,
	eventRank: row.event_rank,
	overallPoints: leagueEventRow?.overall_points ?? null,
	overallRank: leagueEventRow?.overall_rank ?? null,
	eventChip: normalizeTournamentChip(leagueEventRow?.event_chip),
	captainId: leagueEventRow?.captain_id ?? null,
	captainPoints: leagueEventRow?.captain_points ?? null,
	teamValue: leagueEventRow?.team_value ?? null,
	bank: leagueEventRow?.bank ?? null,
});

export const mapTournamentInfoFromViewRow = (row: DbTournamentEventResultRow): TournamentInfo => ({
	id: row._tournament_id,
	name: row._tournament_name,
	creator: row._tournament_creator,
	adminEntryId: row._tournament_admin_entry_id,
	leagueId: row._tournament_league_id,
	leagueType: mapLeagueType(row._tournament_league_type),
	sourceLeagueName: null,
	rosterMode: TournamentRosterMode.SNAPSHOT,
	rosterSyncStatus: null,
	rosterLastSyncedAt: null,
	officialScheduleHash: null,
	officialScheduleSyncedAt: null,
	officialScheduleLockedAt: null,
	totalTeamNum: row._tournament_total_team_num,
	tournamentMode: mapTournamentMode(row._tournament_tournament_mode),
	groupMode: mapGroupMode(row._tournament_group_mode),
	groupTeamNum: row._tournament_group_team_num,
	groupNum: row._tournament_group_num,
	groupStartedEventId: row._tournament_group_started_event_id,
	groupEndedEventId: row._tournament_group_ended_event_id,
	groupAutoAverages: row._tournament_group_auto_averages,
	groupRounds: row._tournament_group_rounds,
	groupPlayAgainstNum: row._tournament_group_play_against_num,
	groupQualifyNum: row._tournament_group_qualify_num,
	knockoutMode: mapKnockoutMode(row._tournament_knockout_mode),
	knockoutTeamNum: row._tournament_knockout_team_num,
	knockoutRounds: row._tournament_knockout_rounds,
	knockoutEventNum: row._tournament_knockout_event_num,
	knockoutStartedEventId: row._tournament_knockout_started_event_id,
	knockoutEndedEventId: row._tournament_knockout_ended_event_id,
	knockoutPlayAgainstNum: row._tournament_knockout_play_against_num,
	state: mapTournamentState(row._tournament_state),
	setupStatus: TournamentSetupStatus.READY,
	setupPhase: TournamentSetupPhase.READY,
	setupCompletedUnits: 0,
	setupTotalUnits: 0,
	setupProgressUpdatedAt: null,
	standingsReadyAt: toIsoDateTime(row._tournament_updated_at),
	setupHasWarnings: false,
	setupProgressMode: TournamentSetupProgressMode.DETERMINATE,
	setupAttempt: 0,
	setupMaxAttempts: 3,
	nextRetryAt: null,
	profilesReadyAt: null,
	insightsReadyAt: toIsoDateTime(row._tournament_updated_at),
	warningSummaries: [],
	setupStartedAt: null,
	setupFinishedAt: toIsoDateTime(row._tournament_updated_at),
	createdAt: toIsoDateTime(row._tournament_created_at),
	updatedAt: toIsoDateTime(row._tournament_updated_at),
});

export const mapTournamentEventResultFromView = (
	tournament: TournamentInfo,
	row: DbTournamentEventResultRow
): TournamentEventResult => ({
	tournament,
	eventId: row.event_id,
	groupId: row.group_id,
	entryId: row.entry_id,
	entryName: row.entry_name,
	playerName: row.player_name,
	eventGroupRank: row.event_group_rank,
	eventPoints: row.event_points,
	eventCost: row.event_cost,
	eventNetPoints: row.event_net_points,
	eventRank: row.event_rank,
	overallPoints: row.overall_points,
	overallRank: row.overall_rank,
	eventChip: normalizeTournamentChip(row.event_chip),
	captainId: row.captain_id,
	captainPoints: row.captain_points,
	teamValue: row.team_value,
	bank: row.bank,
});

export const mapTournamentBattleGroupResult = (
	tournament: TournamentInfo,
	row: DbTournamentBattleGroupResultRow,
	entryNames: Map<number, DbEntryInfoNameRow>
): TournamentBattleGroupResult => {
	if (row.home_entry_id === null || row.away_entry_id === null) {
		throw new Error("Custom battle result cannot contain an Average side");
	}
	const home = entryNames.get(row.home_entry_id);
	const away = entryNames.get(row.away_entry_id);
	return {
		tournament,
		matchId: row.id,
		groupId: row.group_id,
		eventId: row.event_id,
		homeEntryId: row.home_entry_id,
		homeEntryName: home?.entry_name ?? null,
		homePlayerName: home?.player_name ?? null,
		homeNetPoints: row.home_net_points,
		homeRank: row.home_rank,
		homeMatchPoints: row.home_match_points,
		awayEntryId: row.away_entry_id,
		awayEntryName: away?.entry_name ?? null,
		awayPlayerName: away?.player_name ?? null,
		awayNetPoints: row.away_net_points,
		awayRank: row.away_rank,
		awayMatchPoints: row.away_match_points,
	};
};

export const mapEntryH2HMatchResult = (
	tournament: TournamentInfo,
	row: DbTournamentBattleGroupResultRow,
	entryId: number,
	entryNames: Map<number, DbEntryInfoNameRow>,
	eventResults: Map<string, DbEntryEventResultLiteRow>
): EntryH2HMatchResult => {
	if (row.home_entry_id === null || row.away_entry_id === null) {
		throw new Error("Custom entry H2H result cannot contain an Average side");
	}
	const isHome = row.home_entry_id === entryId;
	const myEntryId = isHome ? row.home_entry_id : row.away_entry_id;
	const oppEntryId = isHome ? row.away_entry_id : row.home_entry_id;
	const myName = entryNames.get(myEntryId);
	const oppName = entryNames.get(oppEntryId);
	const myEvent = eventResults.get(`${myEntryId}-${row.event_id}`);
	const oppEvent = eventResults.get(`${oppEntryId}-${row.event_id}`);
	return {
		tournament,
		matchId: row.id,
		groupId: row.group_id,
		eventId: row.event_id,
		entryId: myEntryId,
		entryName: myName?.entry_name ?? null,
		playerName: myName?.player_name ?? null,
		entryNetPoints: isHome ? row.home_net_points : row.away_net_points,
		entryRank: isHome ? row.home_rank : row.away_rank,
		entryMatchPoints: isHome ? row.home_match_points : row.away_match_points,
		entryEventPoints: myEvent?.event_points ?? null,
		entryTransferCost: myEvent?.event_transfers_cost ?? null,
		entryOverallRank: myEvent?.overall_rank ?? null,
		entryChip: normalizeTournamentChip(myEvent?.event_chip),
		opponentEntryId: oppEntryId,
		opponentEntryName: oppName?.entry_name ?? null,
		opponentPlayerName: oppName?.player_name ?? null,
		opponentNetPoints: isHome ? row.away_net_points : row.home_net_points,
		opponentRank: isHome ? row.away_rank : row.home_rank,
		opponentMatchPoints: isHome ? row.away_match_points : row.home_match_points,
		opponentEventPoints: oppEvent?.event_points ?? null,
		opponentTransferCost: oppEvent?.event_transfers_cost ?? null,
		opponentOverallRank: oppEvent?.overall_rank ?? null,
		opponentChip: normalizeTournamentChip(oppEvent?.event_chip),
	};
};

const getTournamentInfoUncached = async (
	context: GraphQLContext,
	tournamentId: number
): Promise<TournamentInfo | null> => {
	const { data, error } = await context.data
		.read("competition.tournaments")
		.select(TOURNAMENT_INFO_COLUMNS)
		.eq("id", tournamentId)
		.limit(1);

	if (error) {
		context.logger.error({ err: error, tournamentId }, "Failed to fetch tournament");
		throw new Error("Failed to fetch tournament");
	}

	const row = data?.[0] as DbTournamentInfoRow | undefined;
	if (!row) {
		return null;
	}
	return mapTournamentInfo(row);
};

const getTournamentInfosUncached = async (
	context: GraphQLContext,
	tournamentIds: readonly number[]
): Promise<TournamentInfo[]> => {
	const uniqueIds = [...new Set(tournamentIds)];
	if (uniqueIds.length === 0) return [];

	const { data, error } = await context.data
		.read("competition.tournaments")
		.select(TOURNAMENT_INFO_COLUMNS)
		.in("id", uniqueIds);

	if (error) {
		context.logger.error(
			{ err: error, tournamentCount: uniqueIds.length },
			"Failed to fetch tournaments"
		);
		throw new Error("Failed to fetch tournaments");
	}

	return ((data as DbTournamentInfoRow[] | null) ?? []).map(mapTournamentInfo);
};

const getTournamentInfoById = async (
	context: GraphQLContext,
	tournamentId: number
): Promise<TournamentInfo | null> => getTournamentInfoUncached(context, tournamentId);

const getTournamentCacheReadiness = async (
	context: GraphQLContext,
	tournamentId: number
): Promise<boolean> => {
	const { data, error } = await context.data
		.read("competition.tournaments")
		.select("standings_ready_at, setup_status")
		.eq("id", tournamentId)
		.limit(1);

	if (error) {
		context.logger.error({ err: error, tournamentId }, "Failed to fetch tournament readiness");
		throw new Error("Failed to fetch tournament readiness");
	}

	const row = (
		data as Array<{ standings_ready_at: string | null; setup_status: string }> | null
	)?.[0];
	if (!row) return false;
	return row.setup_status === TournamentSetupStatus.READY;
};

interface TournamentsRepository {
	getTournamentInfoUncached(
		context: GraphQLContext,
		tournamentId: number
	): Promise<TournamentInfo | null>;
	getTournamentInfosUncached(
		context: GraphQLContext,
		tournamentIds: readonly number[]
	): Promise<TournamentInfo[]>;
	getTournamentForMember(
		context: GraphQLContext,
		tournamentId: number,
		entryId: number
	): Promise<TournamentInfo | null>;
	getManagedTournament(
		context: GraphQLContext,
		tournamentId: number,
		entryId: number
	): Promise<TournamentInfo | null>;
	getTournamentParticipants(
		context: GraphQLContext,
		tournamentId: number
	): Promise<TournamentParticipant[]>;
	getEntryTournaments(context: GraphQLContext, entryId: number): Promise<TournamentInfo[]>;
	getEntryParticipatingTournaments(
		context: GraphQLContext,
		entryId: number
	): Promise<TournamentInfo[]>;
	getManageableTournaments(context: GraphQLContext, entryId: number): Promise<TournamentInfo[]>;
	getTournamentEntryIds(context: GraphQLContext, tournamentId: number): Promise<number[]>;
	getTournamentEntryIdsUncached(context: GraphQLContext, tournamentId: number): Promise<number[]>;
	getTournamentEventResults(
		context: GraphQLContext,
		tournamentId: number,
		eventId: number,
		limit: number | null,
		offset: number | null
	): Promise<TournamentEventResult[]>;
	getTournamentEntryRankingSummary(
		context: GraphQLContext,
		tournamentId: number,
		eventId: number,
		entryId: number
	): Promise<TournamentEntryRankingSummary>;
	getTournamentSeasonSnapshot(
		context: GraphQLContext,
		tournamentId: number,
		eventId: number
	): Promise<TournamentSeasonSnapshot>;
	getTournamentBattleGroupResults(
		context: GraphQLContext,
		tournamentId: number,
		eventId: number
	): Promise<TournamentBattleGroupResult[]>;
	getEntryH2HMatchResults(context: GraphQLContext, entryId: number): Promise<EntryH2HMatchResult[]>;
	getTournamentOfficialH2H(
		context: GraphQLContext,
		tournamentId: number,
		eventId: number
	): Promise<TournamentOfficialH2H>;
	getEntryOfficialH2HDesk(
		context: GraphQLContext,
		entryId: number
	): Promise<EntryOfficialH2HDeskItem[]>;
	getTournamentDetailDesk(
		context: GraphQLContext,
		tournamentId: number,
		entryId: number,
		eventId?: number | null
	): Promise<TournamentDetailDesk | null>;
	getManagedTournamentStatus(
		context: GraphQLContext,
		tournamentId: number,
		entryId: number
	): Promise<ManagedTournamentStatus | null>;
}

const emptyRankingGaps = {
	overallPoints: null as number | null,
	leaderOverallPoints: null as number | null,
	gapToLeader: null as number | null,
	pointsBehindNext: null as number | null,
	pointsAheadOfPrev: null as number | null,
};

function isDefined<T>(value: T | null | undefined): value is T {
	return value !== null && value !== undefined;
}

function computeRankingGapsFromStandings(
	standings: TournamentSeasonStandingRow[],
	entryId: number
): typeof emptyRankingGaps {
	const rankedStandings = standings.filter(
		(row) => isDefined(row.overallPoints) && Number.isFinite(row.overallPoints)
	);
	if (rankedStandings.length === 0) return { ...emptyRankingGaps };

	const myIndex = rankedStandings.findIndex((row) => row.entryId === entryId);
	const my = myIndex >= 0 ? rankedStandings[myIndex] : undefined;
	const leader = rankedStandings[0];
	const above = myIndex > 0 ? rankedStandings[myIndex - 1] : undefined;
	const below =
		myIndex >= 0 && myIndex < rankedStandings.length - 1 ? rankedStandings[myIndex + 1] : undefined;

	const overallPoints = my?.overallPoints ?? null;
	const leaderOverallPoints = leader?.overallPoints ?? null;
	const gapToLeader =
		isDefined(overallPoints) && isDefined(leaderOverallPoints)
			? Math.max(0, leaderOverallPoints - overallPoints)
			: null;
	const pointsBehindNext =
		myIndex === 0
			? 0
			: isDefined(overallPoints) && isDefined(above?.overallPoints)
				? Math.max(0, above.overallPoints - overallPoints)
				: null;
	const pointsAheadOfPrev =
		myIndex >= 0 && myIndex === rankedStandings.length - 1
			? 0
			: isDefined(overallPoints) && isDefined(below?.overallPoints)
				? Math.max(0, overallPoints - below.overallPoints)
				: null;

	return {
		overallPoints,
		leaderOverallPoints,
		gapToLeader,
		pointsBehindNext,
		pointsAheadOfPrev,
	};
}

type NamedMetricSample = {
	entryId: number;
	value: number;
	entryName: string | null;
	playerName: string | null;
};

function averageOf(values: number[]): number | null {
	if (values.length === 0) return null;
	return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Pick leader: higherIsBetter → max value, else min value (transfers/costs ranks).
 * Tie-break: lower entryId.
 */
function pickMetricLeader(
	samples: NamedMetricSample[],
	higherIsBetter: boolean
): NamedMetricSample | null {
	if (samples.length === 0) return null;
	return samples.reduce((best, cur) => {
		if (higherIsBetter) {
			if (cur.value > best.value) return cur;
			if (cur.value < best.value) return best;
		} else {
			if (cur.value < best.value) return cur;
			if (cur.value > best.value) return best;
		}
		return cur.entryId < best.entryId ? cur : best;
	});
}

function buildMetric(
	key: TournamentSeasonMetricKey,
	samples: NamedMetricSample[],
	higherIsBetter: boolean
): TournamentSeasonMetric {
	const leader = pickMetricLeader(samples, higherIsBetter);
	const avg = averageOf(samples.map((s) => s.value));
	return {
		key,
		leaderValue: leader?.value ?? null,
		leaderEntryId: leader?.entryId ?? null,
		leaderEntryName: leader?.entryName ?? null,
		leaderPlayerName: leader?.playerName ?? null,
		averageValue: avg === null ? null : Math.round(avg * 100) / 100,
		higherIsBetter,
	};
}

function buildSeasonSnapshotFromEventResults(
	eventId: number,
	results: TournamentEventResult[],
	snapshotRows: DbTournamentEventSnapshotRow[] = []
): TournamentSeasonSnapshot {
	const ordered = [...results].sort((a, b) => {
		const pointsA =
			isDefined(a.overallPoints) && Number.isFinite(a.overallPoints) ? a.overallPoints : null;
		const pointsB =
			isDefined(b.overallPoints) && Number.isFinite(b.overallPoints) ? b.overallPoints : null;
		if (isDefined(pointsA) && isDefined(pointsB) && pointsA !== pointsB) {
			return pointsB - pointsA;
		}
		if (isDefined(pointsA) && !isDefined(pointsB)) return -1;
		if (!isDefined(pointsA) && isDefined(pointsB)) return 1;
		const overallRankA = a.overallRank ?? Number.MAX_SAFE_INTEGER;
		const overallRankB = b.overallRank ?? Number.MAX_SAFE_INTEGER;
		if (overallRankA !== overallRankB) return overallRankA - overallRankB;
		return a.entryId - b.entryId;
	});

	const standings: TournamentSeasonStandingRow[] = ordered.map((row, index) => ({
		entryId: row.entryId,
		rank: isDefined(row.overallPoints) && Number.isFinite(row.overallPoints) ? index + 1 : null,
		entryName: row.entryName,
		playerName: row.playerName,
		overallPoints: row.overallPoints,
		overallRank: row.overallRank,
		teamValue: row.teamValue,
	}));

	const nameByEntry = new Map<number, { entryName: string | null; playerName: string | null }>();
	for (const row of results) {
		nameByEntry.set(row.entryId, {
			entryName: row.entryName,
			playerName: row.playerName,
		});
	}

	const withPoints = standings.filter(
		(s) => isDefined(s.overallPoints) && Number.isFinite(s.overallPoints)
	);
	const leaderOverallPoints = withPoints[0]?.overallPoints ?? null;
	const secondOverallPoints = withPoints[1]?.overallPoints ?? null;
	const gapFirstSecond =
		isDefined(leaderOverallPoints) && isDefined(secondOverallPoints)
			? leaderOverallPoints - secondOverallPoints
			: null;
	const averageOverallPoints =
		withPoints.length > 0
			? Math.round(
					withPoints.reduce((sum, s) => sum + (s.overallPoints as number), 0) / withPoints.length
				)
			: null;

	const pointsSamples: NamedMetricSample[] = results
		.filter((r) => isDefined(r.overallPoints) && Number.isFinite(r.overallPoints))
		.map((r) => ({
			entryId: r.entryId,
			value: r.overallPoints as number,
			entryName: r.entryName,
			playerName: r.playerName,
		}));

	const teamValueSamples: NamedMetricSample[] = results
		.filter((r) => isDefined(r.teamValue) && Number.isFinite(r.teamValue))
		.map((r) => ({
			entryId: r.entryId,
			value: r.teamValue as number,
			entryName: r.entryName,
			playerName: r.playerName,
		}));

	const snapNamed = (entryId: number, value: number): NamedMetricSample => {
		const names = nameByEntry.get(entryId);
		return {
			entryId,
			value,
			entryName: names?.entryName ?? null,
			playerName: names?.playerName ?? null,
		};
	};

	const transferSamples: NamedMetricSample[] = [];
	const costSamples: NamedMetricSample[] = [];
	const benchSamples: NamedMetricSample[] = [];
	const autoSubSamples: NamedMetricSample[] = [];

	for (const row of snapshotRows) {
		if (isDefined(row.cum_transfers_num) && Number.isFinite(row.cum_transfers_num)) {
			transferSamples.push(snapNamed(row.entry_id, row.cum_transfers_num));
		}
		if (isDefined(row.cum_total_costs) && Number.isFinite(row.cum_total_costs)) {
			costSamples.push(snapNamed(row.entry_id, row.cum_total_costs));
		}
		if (isDefined(row.cum_total_bench_points) && Number.isFinite(row.cum_total_bench_points)) {
			benchSamples.push(snapNamed(row.entry_id, row.cum_total_bench_points));
		}
		if (isDefined(row.cum_auto_sub_points) && Number.isFinite(row.cum_auto_sub_points)) {
			autoSubSamples.push(snapNamed(row.entry_id, row.cum_auto_sub_points));
		}
		// Prefer MV team value when present (authoritative cumulative snapshot)
		if (isDefined(row.team_value) && Number.isFinite(row.team_value)) {
			const existing = teamValueSamples.find((s) => s.entryId === row.entry_id);
			if (existing) existing.value = row.team_value;
			else teamValueSamples.push(snapNamed(row.entry_id, row.team_value));
		}
	}

	const metrics: TournamentSeasonMetric[] = [
		buildMetric("OVERALL_POINTS", pointsSamples, true),
		buildMetric("TEAM_VALUE", teamValueSamples, true),
		buildMetric("TRANSFERS", transferSamples, false),
		buildMetric("TOTAL_COSTS", costSamples, false),
		buildMetric("BENCH_POINTS", benchSamples, true),
		buildMetric("AUTO_SUB_POINTS", autoSubSamples, true),
	];

	return {
		asOfEventId: eventId,
		entryCount: standings.length,
		leaderOverallPoints,
		secondOverallPoints,
		gapFirstSecond,
		averageOverallPoints,
		metrics,
		standings,
	};
}

const SEASON_METRIC_KEYS = new Set<TournamentSeasonMetricKey>([
	"OVERALL_POINTS",
	"TEAM_VALUE",
	"TRANSFERS",
	"TOTAL_COSTS",
	"BENCH_POINTS",
	"AUTO_SUB_POINTS",
]);

const isSeasonMetricCache = (value: unknown): value is TournamentSeasonMetric => {
	if (!isRecord(value)) return false;
	return (
		isRequired(
			value,
			"key",
			(candidate) =>
				typeof candidate === "string" &&
				SEASON_METRIC_KEYS.has(candidate as TournamentSeasonMetricKey)
		) &&
		isRequired(value, "leaderValue", isNullableFiniteNumber) &&
		isRequired(value, "leaderEntryId", isNullableSafeInteger) &&
		isRequired(value, "leaderEntryName", isNullableString) &&
		isRequired(value, "leaderPlayerName", isNullableString) &&
		isRequired(value, "averageValue", isNullableFiniteNumber) &&
		isRequired(value, "higherIsBetter", (candidate) => typeof candidate === "boolean")
	);
};

const isSeasonStandingCache = (value: unknown): value is TournamentSeasonStandingRow => {
	if (!isRecord(value)) return false;
	return (
		isRequired(value, "entryId", isSafeInteger) &&
		isRequired(value, "rank", isNullableSafeInteger) &&
		isRequired(value, "entryName", isNullableString) &&
		isRequired(value, "playerName", isNullableString) &&
		isRequired(value, "overallPoints", isNullableSafeInteger) &&
		isRequired(value, "overallRank", isNullableSafeInteger) &&
		isRequired(value, "teamValue", isNullableSafeInteger)
	);
};

const isSeasonSnapshotCache = (value: unknown): value is TournamentSeasonSnapshot => {
	if (!isRecord(value)) return false;
	return (
		isRequired(value, "asOfEventId", isSafeInteger) &&
		isRequired(value, "entryCount", isSafeInteger) &&
		isRequired(value, "leaderOverallPoints", isNullableSafeInteger) &&
		isRequired(value, "secondOverallPoints", isNullableSafeInteger) &&
		isRequired(value, "gapFirstSecond", isNullableSafeInteger) &&
		isRequired(value, "averageOverallPoints", isNullableSafeInteger) &&
		isRequired(
			value,
			"metrics",
			(candidate) => Array.isArray(candidate) && candidate.every(isSeasonMetricCache)
		) &&
		isRequired(
			value,
			"standings",
			(candidate) => Array.isArray(candidate) && candidate.every(isSeasonStandingCache)
		)
	);
};

export const tournamentCacheTestables = {
	isTournamentInfoCache,
	isTournamentSetupWarningSummaryCache,
	isTournamentEventResultCache,
	isRankingSummaryCache,
	isBattleResultCache,
	isH2HResultCache,
	isSeasonSnapshotCache,
	isEntryIdArrayCache,
	officialBattleRowsAreCompleteForEntries,
	officialKnockoutRowsAreCompleteForFinalizedEvent,
	officialH2HCurrentEventIsComplete,
	selectCurrentOfficialH2HProjection,
	suppressActiveOfficialH2HScores,
	loadEventLiveH2HScoreBatches,
	applyActiveOfficialH2HScoreAuthority,
	tournamentCacheKey,
};

const hasPlatformAdminAccess = (context: GraphQLContext, entryId: number): boolean =>
	context.principal?.source === "website" &&
	context.principal.platformAdmin === true &&
	context.principal.fplEntryId === entryId &&
	Boolean(context.principal.fplEntryVerifiedAt);

export const tournamentsRepository: TournamentsRepository = {
	getTournamentInfoUncached,
	getTournamentInfosUncached,

	async getTournamentForMember(
		context: GraphQLContext,
		tournamentId: number,
		entryId: number
	): Promise<TournamentInfo | null> {
		if (!hasPlatformAdminAccess(context, entryId)) {
			const rosterMembership = await context.data
				.read("competition.tournament_entries")
				.select("entry_id")
				.eq("tournament_id", tournamentId)
				.eq("entry_id", entryId)
				.limit(1);
			if (rosterMembership.error) {
				context.logger.error(
					{ err: rosterMembership.error, tournamentId, entryId },
					"Failed to verify tournament roster membership"
				);
				throw new Error("Failed to fetch tournament");
			}
			const isRosterMember =
				((rosterMembership.data as { entry_id: number }[] | null) ?? []).length > 0;
			if (!isRosterMember) {
				const officialLeagueMembership = await context.data
					.read("competition.entry_leagues_with_tournament")
					.select("tournament_id")
					.eq("entry_id", entryId)
					.eq("tournament_id", tournamentId)
					.limit(1);
				if (officialLeagueMembership.error) {
					context.logger.error(
						{ err: officialLeagueMembership.error, tournamentId, entryId },
						"Failed to verify official league membership"
					);
					throw new Error("Failed to fetch tournament");
				}
				const isOfficialLeagueMember =
					((officialLeagueMembership.data as { tournament_id: number | null }[] | null) ?? [])
						.length > 0;
				if (!isOfficialLeagueMember) return null;
			}
		}
		return getTournamentInfoUncached(context, tournamentId);
	},

	async getManagedTournament(
		context: GraphQLContext,
		tournamentId: number,
		entryId: number
	): Promise<TournamentInfo | null> {
		const query = context.data
			.read("competition.tournaments")
			.select(TOURNAMENT_INFO_COLUMNS)
			.eq("id", tournamentId);
		if (!hasPlatformAdminAccess(context, entryId)) query.eq("admin_entry_id", entryId);
		const { data, error } = await query.limit(1);
		if (error) {
			context.logger.error(
				{ err: error, tournamentId, entryId },
				"Failed to fetch managed tournament"
			);
			throw new Error("Failed to fetch tournament");
		}
		const row = data?.[0] as DbTournamentInfoRow | undefined;
		return row ? mapTournamentInfo(row) : null;
	},

	async getTournamentParticipants(
		context: GraphQLContext,
		tournamentId: number
	): Promise<TournamentParticipant[]> {
		const { data: membershipData, error: membershipError } = await context.data
			.read("competition.tournament_entries")
			.select("entry_id")
			.eq("tournament_id", tournamentId)
			.order("entry_id", { ascending: true });
		if (membershipError) {
			context.logger.error({ err: membershipError, tournamentId }, "Failed to fetch participants");
			throw new Error("Failed to fetch tournament participants");
		}
		const entryIds = ((membershipData as { entry_id: number }[] | null) ?? []).map(
			(row) => row.entry_id
		);
		if (entryIds.length === 0) return [];

		const { data: entryData, error: entryError } = await context.data
			.read("competition.entries")
			.select("id, entry_name, player_name")
			.in("id", entryIds)
			.order("id", { ascending: true });
		if (entryError) {
			context.logger.error({ err: entryError, tournamentId }, "Failed to fetch participant names");
			throw new Error("Failed to fetch tournament participants");
		}
		const entryById = new Map(
			((entryData as DbEntryInfoNameRow[] | null) ?? []).map((entry) => [entry.id, entry])
		);
		return entryIds.map((entryId) => ({
			entryId,
			entryName: entryById.get(entryId)?.entry_name ?? null,
			playerName: entryById.get(entryId)?.player_name ?? null,
		}));
	},

	async getEntryTournaments(context: GraphQLContext, entryId: number): Promise<TournamentInfo[]> {
		// Mutable metadata is read directly for lightweight roots. Legacy callers
		// that already pinned a core revision retain the existing bounded cache
		// contract during the rolling migration.
		const platformAdmin = hasPlatformAdminAccess(context, entryId);
		const cacheScope = platformAdmin ? "platform-admin" : "entry";
		const cacheKey = context.dataRevision
			? tournamentCacheKey(context, `${cacheScope}:visible-v2:${entryId}`)
			: null;
		if (cacheKey) {
			const cached = await readJsonQueryCache(context, cacheKey, (value) =>
				isTournamentInfoArrayCache(value) ? value : null
			);
			if (
				Array.isArray(cached) &&
				cached.every((item) => isRecord(item) && Number.isFinite(Number(item.id)))
			) {
				return cached as TournamentInfo[];
			}
		}
		let tournamentIds: number[] | null = null;
		if (!platformAdmin) {
			const [rosterMemberships, officialLeagueMemberships] = await Promise.all([
				context.data
					.read("competition.tournament_entries")
					.select("tournament_id")
					.eq("entry_id", entryId),
				context.data
					.read("competition.entry_leagues_with_tournament")
					.select("tournament_id")
					.eq("entry_id", entryId),
			]);

			if (rosterMemberships.error) {
				context.logger.error(
					{ err: rosterMemberships.error, entryId },
					"Failed to fetch tournament roster memberships"
				);
				throw new Error("Failed to fetch tournament memberships");
			}
			if (officialLeagueMemberships.error) {
				context.logger.error(
					{ err: officialLeagueMemberships.error, entryId },
					"Failed to fetch tracked official league memberships"
				);
				throw new Error("Failed to fetch tournament memberships");
			}

			const officialTournamentIds = (
				(officialLeagueMemberships.data as { tournament_id: number | null }[] | null) ?? []
			).flatMap((row) =>
				Number.isSafeInteger(row.tournament_id) && Number(row.tournament_id) > 0
					? [{ tournament_id: Number(row.tournament_id) }]
					: []
			);
			tournamentIds = extractTournamentIds([
				...((rosterMemberships.data as DbTournamentEntryRow[] | null) ?? []),
				...officialTournamentIds,
			]);
			if (tournamentIds.length === 0) {
				if (cacheKey)
					await writeQueryCache(
						context,
						cacheKey,
						JSON.stringify([]),
						QUERY_CACHE_TTL_SECONDS.REPORTING
					);
				return [];
			}
		}

		const infoQuery = context.data.read("competition.tournaments").select(TOURNAMENT_INFO_COLUMNS);
		if (tournamentIds) infoQuery.in("id", tournamentIds);
		const { data: infoData, error: infoError } = await infoQuery.order("id", {
			ascending: true,
		});

		if (infoError) {
			context.logger.error({ err: infoError, entryId }, "Failed to fetch tournament details");
			throw new Error("Failed to fetch tournament details");
		}

		const tournaments = ((infoData as DbTournamentInfoRow[] | null) ?? []).map(mapTournamentInfo);
		const warningSummariesByTournament = await getTournamentSetupWarningSummariesByTournamentIds(
			context,
			tournaments.map((tournament) => tournament.id)
		);
		const tournamentsWithWarnings = tournaments.map((tournament) => ({
			...tournament,
			warningSummaries: warningSummariesByTournament.get(tournament.id) ?? [],
		}));
		if (cacheKey) {
			const allStandingsReady = tournamentsWithWarnings.every(
				(tournament) => tournament.standingsReadyAt !== null
			);
			const ttlSeconds = allStandingsReady
				? QUERY_CACHE_TTL_SECONDS.REPORTING
				: Math.min(15, QUERY_CACHE_TTL_SECONDS.REPORTING);
			await writeQueryCache(context, cacheKey, JSON.stringify(tournamentsWithWarnings), ttlSeconds);
		}
		return tournamentsWithWarnings;
	},

	async getEntryParticipatingTournaments(
		context: GraphQLContext,
		entryId: number
	): Promise<TournamentInfo[]> {
		const [rosterMemberships, officialLeagueMemberships] = await Promise.all([
			context.data
				.read("competition.tournament_entries")
				.select("tournament_id")
				.eq("entry_id", entryId),
			context.data
				.read("competition.entry_leagues_with_tournament")
				.select("tournament_id")
				.eq("entry_id", entryId),
		]);
		if (rosterMemberships.error || officialLeagueMemberships.error) {
			context.logger.error(
				{
					entryId,
					rosterError: rosterMemberships.error,
					officialLeagueError: officialLeagueMemberships.error,
				},
				"Failed to fetch participating tournaments"
			);
			throw new Error("Failed to fetch participating tournaments");
		}
		const tournamentIds = extractTournamentIds([
			...((rosterMemberships.data as DbTournamentEntryRow[] | null) ?? []),
			...((officialLeagueMemberships.data as { tournament_id: number | null }[] | null) ?? []).map(
				(row) => ({ tournament_id: row.tournament_id })
			),
		]);
		if (tournamentIds.length === 0) return [];
		const { data, error } = await context.data
			.read("competition.tournaments")
			.select(TOURNAMENT_INFO_COLUMNS)
			.in("id", tournamentIds)
			.order("id", { ascending: true });
		if (error) {
			context.logger.error(
				{ err: error, entryId },
				"Failed to fetch participating tournament details"
			);
			throw new Error("Failed to fetch participating tournaments");
		}
		const tournaments = ((data as DbTournamentInfoRow[] | null) ?? []).map(mapTournamentInfo);
		const warningSummariesByTournament = await getTournamentSetupWarningSummariesByTournamentIds(
			context,
			tournaments.map((tournament) => tournament.id)
		);
		return tournaments.map((tournament) => ({
			...tournament,
			warningSummaries: warningSummariesByTournament.get(tournament.id) ?? [],
		}));
	},

	async getManageableTournaments(
		context: GraphQLContext,
		entryId: number
	): Promise<TournamentInfo[]> {
		const query = context.data.read("competition.tournaments").select(TOURNAMENT_INFO_COLUMNS);
		if (!hasPlatformAdminAccess(context, entryId)) query.eq("admin_entry_id", entryId);
		const { data, error } = await query.order("id", { ascending: true });
		if (error) {
			context.logger.error({ err: error, entryId }, "Failed to fetch manageable tournaments");
			throw new Error("Failed to fetch manageable tournaments");
		}
		const tournaments = ((data as DbTournamentInfoRow[] | null) ?? []).map(mapTournamentInfo);
		const warningSummariesByTournament = await getTournamentSetupWarningSummariesByTournamentIds(
			context,
			tournaments.map((tournament) => tournament.id)
		);
		return tournaments.map((tournament) => ({
			...tournament,
			warningSummaries: warningSummariesByTournament.get(tournament.id) ?? [],
		}));
	},

	async getTournamentEntryIds(context: GraphQLContext, tournamentId: number): Promise<number[]> {
		if (!context.dataRevision)
			return tournamentsRepository.getTournamentEntryIdsUncached(context, tournamentId);
		const cacheKey = tournamentCacheKey(context, `entry-ids:${tournamentId}`);
		if (!(await getTournamentCacheReadiness(context, tournamentId))) {
			await deleteQueryCache(context, cacheKey);
			return tournamentsRepository.getTournamentEntryIdsUncached(context, tournamentId);
		}
		const cached = await readJsonQueryCache(context, cacheKey, (value) =>
			isEntryIdArrayCache(value) ? value : null
		);
		if (Array.isArray(cached)) return cached;
		const entryIds = await tournamentsRepository.getTournamentEntryIdsUncached(
			context,
			tournamentId
		);
		await writeQueryCache(
			context,
			cacheKey,
			JSON.stringify(entryIds),
			QUERY_CACHE_TTL_SECONDS.REPORTING
		);
		return entryIds;
	},

	async getTournamentEntryIdsUncached(
		context: GraphQLContext,
		tournamentId: number
	): Promise<number[]> {
		const { data, error } = await context.data
			.read("competition.tournament_entries")
			.select("entry_id")
			.eq("tournament_id", tournamentId);

		if (error) {
			context.logger.error({ err: error, tournamentId }, "Failed to fetch tournament entry IDs");
			throw new Error("Failed to fetch tournament entry IDs");
		}

		return ((data as { entry_id: number }[] | null) ?? []).map((row) => row.entry_id);
	},

	async getTournamentEventResults(
		context: GraphQLContext,
		tournamentId: number,
		eventId: number,
		limit: number | null = null,
		offset: number | null = null
	): Promise<TournamentEventResult[]> {
		const pagination = normalizeTournamentEventResultsPagination(limit, offset);
		const isPaged = pagination.limit !== null;
		const cacheKey = context.dataRevision
			? tournamentCacheKey(
					context,
					`event-results:${stableStringify({
						tournamentId,
						eventId,
						...(isPaged ? { limit: pagination.limit, offset: pagination.offset ?? 0 } : {}),
					})}`
				)
			: null;
		const cached = cacheKey
			? await readJsonQueryCache(context, cacheKey, (value) =>
					isTournamentEventResultArrayCache(value) ? value : null
				)
			: undefined;
		if (Array.isArray(cached)) return cached;

		let resultQuery = context.data
			.read("reporting.tournament_event_results")
			.select(TOURNAMENT_VIEW_COLUMNS)
			.eq("tournament_id", tournamentId)
			.eq("event_id", eventId)
			.order("group_id", { ascending: true })
			.order("event_group_rank", { ascending: true, nullsFirst: false })
			.order("entry_id", { ascending: true });
		if (isPaged) {
			resultQuery = resultQuery.range(
				pagination.offset ?? 0,
				(pagination.offset ?? 0) + (pagination.limit ?? 1) - 1
			);
		}
		const { data: resultData, error: resultError } = await resultQuery;

		if (resultError) {
			context.logger.error(
				{ err: resultError, tournamentId, eventId },
				"Failed to fetch tournament event results"
			);
			throw new Error("Failed to fetch tournament event results");
		}

		const rows = (resultData as DbTournamentEventResultRow[] | null) ?? [];
		if (rows.length === 0) {
			if (cacheKey)
				await writeQueryCache(
					context,
					cacheKey,
					JSON.stringify([]),
					QUERY_CACHE_TTL_SECONDS.REPORTING
				);
			return [];
		}

		const tournament = await getTournamentInfoById(context, tournamentId);
		if (!tournament) return [];
		if (tournament.groupMode !== GroupMode.POINTS_RACES) {
			context.logger.warn(
				{ tournamentId, groupMode: tournament.groupMode },
				"Tournament event results only supported for POINTS_RACES; returning empty"
			);
			if (cacheKey)
				await writeQueryCache(
					context,
					cacheKey,
					JSON.stringify([]),
					QUERY_CACHE_TTL_SECONDS.REPORTING
				);
			return [];
		}

		const results = rows.map((row) => mapTournamentEventResultFromView(tournament, row));

		if (cacheKey)
			await writeQueryCache(
				context,
				cacheKey,
				JSON.stringify(results),
				QUERY_CACHE_TTL_SECONDS.REPORTING
			);
		return results;
	},

	async getTournamentEntryRankingSummary(
		context: GraphQLContext,
		tournamentId: number,
		eventId: number,
		entryId: number
	): Promise<TournamentEntryRankingSummary> {
		const cacheKey = tournamentCacheKey(
			context,
			`ranking-summary:${stableStringify({
				tournamentId,
				eventId,
				entryId,
			})}`
		);
		const cached = await readJsonQueryCache(context, cacheKey, (value) =>
			isRankingSummaryCache(value) ? value : null
		);
		if (isRecord(cached)) return cached;

		const emptySummary: TournamentEntryRankingSummary = {
			eventId,
			entryId,
			overallRank: null,
			tournamentOverallRank: null,
			teamValue: null,
			tournamentTeamValueRank: null,
			transfersNum: 0,
			tournamentTransfersRank: null,
			totalCosts: 0,
			tournamentCostsRank: null,
			totalBenchPoints: 0,
			tournamentBenchPointsRank: null,
			autoSubPoints: 0,
			tournamentAutoSubRank: null,
			...emptyRankingGaps,
		};

		const [tournament, snapshotResponse, fieldResults] = await Promise.all([
			getTournamentInfoById(context, tournamentId),
			context.data
				.read("reporting.tournament_entry_event_summaries")
				.select(
					"tournament_id, event_id, entry_id, tournament_overall_rank, overall_rank, team_value, cum_transfers_num, cum_total_costs, cum_total_bench_points, cum_auto_sub_points, tournament_team_value_rank, tournament_transfers_rank, tournament_costs_rank, tournament_bench_points_rank, tournament_auto_sub_rank"
				)
				.eq("tournament_id", tournamentId)
				.eq("event_id", eventId)
				.eq("entry_id", entryId)
				.limit(1),
			// Shared with season snapshot / event results cache — gaps need full field
			tournamentsRepository
				.getTournamentEventResults(context, tournamentId, eventId, null, null)
				.catch((error: unknown) => {
					context.logger.warn(
						{ err: error, tournamentId, eventId, entryId },
						"Tournament field unavailable for optional ranking gaps"
					);
					return null;
				}),
		]);

		if (!tournament || tournament.groupMode !== GroupMode.POINTS_RACES) {
			return emptySummary;
		}

		if (snapshotResponse.error) {
			context.logger.warn(
				{ err: snapshotResponse.error, tournamentId, eventId, entryId },
				"Failed to fetch tournament snapshot metrics for summary — returning empty summary"
			);
			return emptySummary;
		}

		const snapshotRow =
			(snapshotResponse.data?.[0] as DbTournamentEventSnapshotRow | undefined) ?? undefined;

		const gaps = fieldResults
			? computeRankingGapsFromStandings(
					buildSeasonSnapshotFromEventResults(eventId, fieldResults).standings,
					entryId
				)
			: { ...emptyRankingGaps };

		const summary: TournamentEntryRankingSummary = {
			eventId,
			entryId,
			overallRank: normalizeDatabaseInteger(snapshotRow?.overall_rank),
			tournamentOverallRank: normalizeDatabaseInteger(snapshotRow?.tournament_overall_rank),
			teamValue: normalizeDatabaseNumber(snapshotRow?.team_value),
			tournamentTeamValueRank: normalizeDatabaseInteger(snapshotRow?.tournament_team_value_rank),
			transfersNum: normalizeDatabaseNumber(snapshotRow?.cum_transfers_num) ?? 0,
			tournamentTransfersRank: normalizeDatabaseInteger(snapshotRow?.tournament_transfers_rank),
			totalCosts: normalizeDatabaseNumber(snapshotRow?.cum_total_costs) ?? 0,
			tournamentCostsRank: normalizeDatabaseInteger(snapshotRow?.tournament_costs_rank),
			totalBenchPoints: normalizeDatabaseNumber(snapshotRow?.cum_total_bench_points) ?? 0,
			tournamentBenchPointsRank: normalizeDatabaseInteger(
				snapshotRow?.tournament_bench_points_rank
			),
			autoSubPoints: normalizeDatabaseNumber(snapshotRow?.cum_auto_sub_points) ?? 0,
			tournamentAutoSubRank: normalizeDatabaseInteger(snapshotRow?.tournament_auto_sub_rank),
			...gaps,
		};

		if (fieldResults !== null) {
			await writeQueryCache(
				context,
				cacheKey,
				JSON.stringify(summary),
				QUERY_CACHE_TTL_SECONDS.REPORTING
			);
		}
		return summary;
	},

	async getTournamentSeasonSnapshot(
		context: GraphQLContext,
		tournamentId: number,
		eventId: number
	): Promise<TournamentSeasonSnapshot> {
		const empty: TournamentSeasonSnapshot = {
			asOfEventId: eventId,
			entryCount: 0,
			leaderOverallPoints: null,
			secondOverallPoints: null,
			gapFirstSecond: null,
			averageOverallPoints: null,
			metrics: [],
			standings: [],
		};

		if (eventId <= 0) {
			return empty;
		}
		const tournament = await getTournamentInfoById(context, tournamentId);
		if (!tournament || tournament.groupMode !== GroupMode.POINTS_RACES) {
			return empty;
		}

		const cacheKey = tournamentCacheKey(
			context,
			`season-snapshot:${stableStringify({ tournamentId, eventId })}`
		);
		const cached = await readJsonQueryCache(context, cacheKey, (value) =>
			isSeasonSnapshotCache(value) ? value : null
		);
		if (isSeasonSnapshotCache(cached)) {
			return cached;
		}

		const [results, snapshotResponse] = await Promise.all([
			tournamentsRepository.getTournamentEventResults(context, tournamentId, eventId, null, null),
			context.data
				.read("reporting.tournament_entry_event_summaries")
				.select(
					"tournament_id, event_id, entry_id, tournament_overall_rank, overall_rank, team_value, cum_transfers_num, cum_total_costs, cum_total_bench_points, cum_auto_sub_points, tournament_team_value_rank, tournament_transfers_rank, tournament_costs_rank, tournament_bench_points_rank, tournament_auto_sub_rank"
				)
				.eq("tournament_id", tournamentId)
				.eq("event_id", eventId),
		]);

		if (snapshotResponse.error) {
			context.logger.error(
				{ err: snapshotResponse.error, tournamentId, eventId },
				"Failed to fetch tournament event snapshots for season metrics"
			);
			throw new Error("Failed to fetch tournament season metrics");
		}

		const snapshotRows = (snapshotResponse.data as DbTournamentEventSnapshotRow[] | null) ?? [];
		const resultEntryIds = new Set(results.map((row) => row.entryId));
		const snapshotEntryIds = new Set(snapshotRows.map((row) => row.entry_id));
		if (
			snapshotRows.length !== resultEntryIds.size ||
			snapshotEntryIds.size !== resultEntryIds.size ||
			[...snapshotEntryIds].some((entryId) => !resultEntryIds.has(entryId))
		) {
			context.logger.error(
				{
					tournamentId,
					eventId,
					resultEntryCount: resultEntryIds.size,
					snapshotEntryCount: snapshotEntryIds.size,
				},
				"Tournament season metric scope is incomplete"
			);
			throw new Error("Tournament season metrics are incomplete");
		}

		const snapshot = buildSeasonSnapshotFromEventResults(eventId, results, snapshotRows);
		await writeQueryCache(
			context,
			cacheKey,
			JSON.stringify(snapshot),
			QUERY_CACHE_TTL_SECONDS.REPORTING
		);
		return snapshot;
	},

	async getTournamentBattleGroupResults(
		context: GraphQLContext,
		tournamentId: number,
		eventId: number
	): Promise<TournamentBattleGroupResult[]> {
		const cacheKey = tournamentCacheKey(
			context,
			`battle-results:${stableStringify({ tournamentId, eventId })}`
		);
		const cached = await readJsonQueryCache(context, cacheKey, (value) =>
			isBattleResultArrayCache(value) ? value : null
		);
		if (Array.isArray(cached)) return cached;

		const [tournamentResult, matchResult] = await Promise.all([
			getTournamentInfoById(context, tournamentId),
			context.data
				.read("competition.tournament_battle_group_results")
				.select(
					"id, tournament_id, group_id, event_id, home_entry_id, home_net_points, home_rank, home_match_points, away_entry_id, away_net_points, away_rank, away_match_points, official_match_id"
				)
				.eq("tournament_id", tournamentId)
				.eq("event_id", eventId)
				.order("group_id", { ascending: true })
				.order("home_entry_id", { ascending: true }),
		]);

		if (matchResult.error) {
			context.logger.error(
				{ err: matchResult.error, tournamentId, eventId },
				"Failed to fetch tournament battle group results"
			);
			throw new Error("Failed to fetch tournament battle group results");
		}

		const rows = ((matchResult.data as DbTournamentBattleGroupResultRow[] | null) ?? []).filter(
			(row) => row.official_match_id === null || row.official_match_id === undefined
		);
		if (rows.length === 0 || !tournamentResult) {
			await writeQueryCache(
				context,
				cacheKey,
				JSON.stringify([]),
				QUERY_CACHE_TTL_SECONDS.REPORTING
			);
			return [];
		}
		const entryIds = [...new Set(rows.flatMap((row) => [row.home_entry_id, row.away_entry_id]))];

		const { data: nameData } = await context.data
			.read("competition.entries")
			.select("id, entry_name, player_name")
			.in("id", entryIds);

		const entryNameMap = new Map<number, DbEntryInfoNameRow>(
			((nameData as DbEntryInfoNameRow[] | null) ?? []).map((r) => [r.id, r])
		);

		const results = rows.map((row) =>
			mapTournamentBattleGroupResult(tournamentResult, row, entryNameMap)
		);

		await writeQueryCache(
			context,
			cacheKey,
			JSON.stringify(results),
			QUERY_CACHE_TTL_SECONDS.REPORTING
		);
		return results;
	},

	async getEntryH2HMatchResults(
		context: GraphQLContext,
		entryId: number
	): Promise<EntryH2HMatchResult[]> {
		const membershipResult = await context.data
			.read("competition.tournament_entries")
			.select("tournament_id")
			.eq("entry_id", entryId);
		if (membershipResult.error) {
			context.logger.error(
				{ err: membershipResult.error, entryId },
				"Failed to fetch entry tournament memberships"
			);
			throw new Error("Failed to fetch entry H2H match results");
		}
		const membershipTournamentIds = extractTournamentIds(
			(membershipResult.data as DbTournamentEntryRow[] | null) ?? []
		).sort((left, right) => left - right);
		// Membership is read authoritatively before the cache. A roster change
		// selects a new key, while a former entrant's persisted match history is
		// still available under the empty-membership key.
		const cacheKey = tournamentCacheKey(
			context,
			`entry-h2h:${entryId}:${stableStringify(membershipTournamentIds)}`
		);
		const cached = await readJsonQueryCache(context, cacheKey, (value) =>
			isH2HResultArrayCache(value) ? value : null
		);
		if (Array.isArray(cached)) return cached;

		const matchResult = await context.data
			.read("competition.tournament_battle_group_results")
			.select(
				"id, tournament_id, group_id, event_id, home_entry_id, home_net_points, home_rank, home_match_points, away_entry_id, away_net_points, away_rank, away_match_points, official_match_id"
			)
			.or(`home_entry_id.eq.${entryId},away_entry_id.eq.${entryId}`)
			.order("event_id", { ascending: true })
			.order("tournament_id", { ascending: true });
		const { data: matchData, error: matchError } = matchResult;

		if (matchError) {
			context.logger.error({ err: matchError, entryId }, "Failed to fetch entry H2H match results");
			throw new Error("Failed to fetch entry H2H match results");
		}
		const rows = ((matchData as DbTournamentBattleGroupResultRow[] | null) ?? []).filter(
			(row) => row.official_match_id === null || row.official_match_id === undefined
		);
		const tournamentIds = [
			...new Set([...membershipTournamentIds, ...rows.map((row) => row.tournament_id)]),
		];
		const tournamentInfos = await getTournamentInfosUncached(context, tournamentIds);
		const readyTournamentIds = new Set(
			tournamentInfos
				.filter((tournament) => tournament.standingsReadyAt)
				.map((tournament) => tournament.id)
		);
		if (rows.length === 0) {
			if (readyTournamentIds.size === tournamentIds.length) {
				await writeQueryCache(
					context,
					cacheKey,
					JSON.stringify([]),
					QUERY_CACHE_TTL_SECONDS.REPORTING
				);
			}
			return [];
		}
		const readyRows = rows.filter((row) => readyTournamentIds.has(row.tournament_id));
		if (readyRows.length === 0) return [];

		const eventIds = [...new Set(readyRows.map((r) => r.event_id))];
		const allEntryIds = [...new Set(readyRows.flatMap((r) => [r.home_entry_id, r.away_entry_id]))];

		const [nameResult, eventResultData] = await Promise.all([
			context.data
				.read("competition.entries")
				.select("id, entry_name, player_name")
				.in("id", allEntryIds),
			context.data
				.read("competition.entry_event_results")
				.select("entry_id, event_id, event_points, event_transfers_cost, event_chip, overall_rank")
				.in("entry_id", allEntryIds)
				.in("event_id", eventIds),
		]);

		const tournamentMap = new Map<number, TournamentInfo>(
			tournamentInfos.map((tournament) => [tournament.id, tournament])
		);

		const entryNameMap = new Map<number, DbEntryInfoNameRow>(
			((nameResult.data as DbEntryInfoNameRow[] | null) ?? []).map((r) => [r.id, r])
		);

		const eventResultMap = new Map<string, DbEntryEventResultLiteRow>(
			((eventResultData.data as DbEntryEventResultLiteRow[] | null) ?? []).map((r) => [
				`${r.entry_id}-${r.event_id}`,
				r,
			])
		);

		const results = readyRows
			.filter((row) => tournamentMap.has(row.tournament_id))
			.map((row) =>
				mapEntryH2HMatchResult(
					tournamentMap.get(row.tournament_id)!,
					row,
					entryId,
					entryNameMap,
					eventResultMap
				)
			);

		if (readyTournamentIds.size === tournamentIds.length) {
			await writeQueryCache(
				context,
				cacheKey,
				JSON.stringify(results),
				QUERY_CACHE_TTL_SECONDS.REPORTING
			);
		}
		return results;
	},

	async getTournamentOfficialH2H(
		context: GraphQLContext,
		tournamentId: number,
		eventId: number
	): Promise<TournamentOfficialH2H> {
		const tournament = await getTournamentInfoUncached(context, tournamentId);
		if (!tournament || !isOfficialH2HInfo(tournament)) {
			throw new Error("Tournament is not an official H2H mirror");
		}
		const referenceEventResult = await context.data
			.read("fpl.events")
			.select("id, finished, data_checked, is_current, is_next")
			.order("id", { ascending: true });
		if (referenceEventResult.error) throw new Error("Failed to resolve the H2H reference event");
		const referenceEvents = (referenceEventResult.data as DbEventStateRow[] | null) ?? [];
		const referenceEventId = resolveOfficialH2HReferenceEventId(referenceEvents);
		const finalizedEventIds = new Set(
			referenceEvents
				.filter((event) => event.finished && event.data_checked)
				.map((event) => event.id)
		);
		const loadedOfficialH2H = await applyActiveOfficialH2HScoreAuthority(
			context,
			await loadOfficialH2HSnapshots(
				context,
				[tournament],
				eventId,
				referenceEventId,
				eventId < referenceEventId,
				finalizedEventIds
			),
			eventId,
			finalizedEventIds
		);
		const loadedSnapshot = loadedOfficialH2H.get(tournamentId);
		if (loadedSnapshot) return loadedSnapshot.snapshot;

		const [groupResult, battleResult, knockoutResult, historyResult, eventResult] =
			await Promise.all([
				context.data
					.read("competition.tournament_groups")
					.select(
						"tournament_id, entry_id, group_points, group_rank, played, won, drawn, lost, total_net_points"
					)
					.eq("tournament_id", tournamentId)
					.order("group_rank", { ascending: true })
					.order("entry_id", { ascending: true }),
				context.data
					.read("competition.tournament_battle_group_results")
					.select(OFFICIAL_BATTLE_COLUMNS)
					.eq("tournament_id", tournamentId)
					.eq("event_id", eventId)
					.not("official_match_id", "is", null)
					.order("source_order", { ascending: true })
					.order("official_match_id", { ascending: true }),
				context.data
					.read("competition.tournament_knockout_results")
					.select(
						"tournament_id, event_id, home_entry_id, home_net_points, away_entry_id, away_net_points, match_winner, official_match_id, source_order, knockout_name, tiebreak, source_checked_at"
					)
					.eq("tournament_id", tournamentId)
					.eq("event_id", eventId)
					.not("official_match_id", "is", null)
					.order("source_order", { ascending: true })
					.order("official_match_id", { ascending: true }),
				context.data
					.read("competition.tournament_battle_group_results")
					.select(OFFICIAL_BATTLE_COLUMNS)
					.eq("tournament_id", tournamentId)
					.lte("event_id", eventId)
					.not("official_match_id", "is", null)
					.order("event_id", { ascending: true })
					.order("source_order", { ascending: true }),
				context.data
					.read("fpl.events")
					.select("id, finished, data_checked, is_current, is_next")
					.or("is_current.eq.true,is_next.eq.true")
					.order("id", { ascending: true }),
			]);
		if (
			groupResult.error ||
			battleResult.error ||
			knockoutResult.error ||
			historyResult.error ||
			eventResult.error
		) {
			context.logger.error(
				{
					err:
						groupResult.error ??
						battleResult.error ??
						knockoutResult.error ??
						historyResult.error ??
						eventResult.error,
					tournamentId,
					eventId,
				},
				"Failed to fetch official H2H mirror"
			);
			throw new Error("Failed to fetch official H2H mirror");
		}

		const groups = (groupResult.data as DbTournamentGroupRow[] | null) ?? [];
		const battles = (battleResult.data as DbTournamentBattleGroupResultRow[] | null) ?? [];
		const knockouts = (knockoutResult.data as DbTournamentKnockoutResultRow[] | null) ?? [];
		const history = (historyResult.data as DbTournamentBattleGroupResultRow[] | null) ?? [];
		const activeEvents = (eventResult.data as DbEventStateRow[] | null) ?? [];
		const activeEventId = resolveOfficialH2HReferenceEventId(activeEvents);
		const currentProjection = selectCurrentOfficialH2HProjection(
			tournament.totalTeamNum,
			groups,
			history.filter((row) => row.event_id === eventId),
			history,
			eventId,
			activeEventId,
			finalizedEventIds
		);
		const currentEventBattles = history.filter((row) => row.event_id === eventId);
		const currentEventComplete = officialH2HCurrentEventIsComplete(
			currentProjection.currentEventComplete,
			currentEventBattles,
			knockouts,
			eventId,
			finalizedEventIds,
			tournament
		);
		const validatedFinalizedEventIds = new Set(currentProjection.options.finalizedEventIds ?? []);
		if (currentEventComplete && finalizedEventIds.has(eventId)) {
			validatedFinalizedEventIds.add(eventId);
		}
		const historicalStandings =
			eventId < activeEventId
				? projectHistoricalOfficialH2HStandings(
						groups.map((row) => row.entry_id),
						history,
						currentProjection.options
					)
				: null;
		const projectedStandings = historicalStandings ?? currentProjection.standings;
		const entryIds = [
			...new Set(
				[
					...groups.map((row) => row.entry_id),
					...battles.flatMap((row) => [row.home_entry_id, row.away_entry_id]),
					...knockouts.flatMap((row) => [row.home_entry_id, row.away_entry_id]),
				].filter((entryId): entryId is number => entryId !== null)
			),
		];
		const nameResult =
			entryIds.length === 0
				? { data: [] as DbEntryInfoNameRow[], error: null }
				: await context.data
						.read("competition.entries")
						.select("id, entry_name, player_name")
						.in("id", entryIds);
		if (nameResult.error) throw new Error("Failed to fetch official H2H entry names");
		const entryNames = new Map<number, DbEntryInfoNameRow>(
			((nameResult.data as DbEntryInfoNameRow[] | null) ?? []).map((row) => [row.id, row])
		);
		const matches = [
			...battles.map((row) => mapOfficialBattleMatch(row, entryNames, currentProjection.options)),
			...knockouts.map((row) => mapOfficialKnockoutMatch(row, entryNames)),
		].sort(
			(left, right) =>
				left.eventId - right.eventId ||
				left.sourceOrder - right.sourceOrder ||
				left.officialMatchId - right.officialMatchId
		);
		const scoreCheckedAt =
			finalizedEventIds.has(eventId) && currentEventComplete
				? latestOfficialH2HCheckedAt(matches)
				: null;
		const fallbackLoad: OfficialH2HSnapshotLoad = {
			snapshot: {
				tournament,
				eventId,
				awaitingSchedule:
					tournament.officialScheduleLockedAt === null ||
					tournament.officialScheduleLockedAt === undefined,
				scoreSource: scoreCheckedAt ? "FPL_H2H_FINAL" : "UNAVAILABLE",
				scoreRevision: scoreCheckedAt ? `fpl-h2h:${eventId}:${scoreCheckedAt}` : null,
				scoreCheckedAt,
				standings: projectedStandings
					? projectedStandings.map((row) => ({
							...row,
							entryName: entryNames.get(row.entryId)?.entry_name ?? null,
							playerName: entryNames.get(row.entryId)?.player_name ?? null,
						}))
					: groups.map((row) => ({
							entryId: row.entry_id,
							entryName: entryNames.get(row.entry_id)?.entry_name ?? null,
							playerName: entryNames.get(row.entry_id)?.player_name ?? null,
							rank: row.group_rank,
							matchPoints: row.group_points ?? 0,
							played: row.played ?? 0,
							won: row.won ?? 0,
							drawn: row.drawn ?? 0,
							lost: row.lost ?? 0,
							pointsFor: row.total_net_points ?? 0,
						})),
				matches,
			},
			history,
			standingsPublished: currentEventComplete || currentProjection.storedPlayed > 0,
			currentEventComplete,
			validatedFinalizedEventIds,
		};
		const projectedFallback = await applyActiveOfficialH2HScoreAuthority(
			context,
			new Map([[tournamentId, fallbackLoad]]),
			eventId,
			finalizedEventIds
		);
		return projectedFallback.get(tournamentId)?.snapshot ?? fallbackLoad.snapshot;
	},

	async getEntryOfficialH2HDesk(
		context: GraphQLContext,
		entryId: number
	): Promise<EntryOfficialH2HDeskItem[]> {
		const [rosterMemberships, officialLeagueMemberships] = await Promise.all([
			context.data
				.read("competition.tournament_entries")
				.select("tournament_id")
				.eq("entry_id", entryId),
			context.data
				.read("competition.entry_leagues_with_tournament")
				.select("tournament_id")
				.eq("entry_id", entryId),
		]);
		if (rosterMemberships.error || officialLeagueMemberships.error) {
			throw new Error("Failed to fetch official H2H memberships");
		}
		const canonicalTournamentIds = (
			(officialLeagueMemberships.data as { tournament_id: number | null }[] | null) ?? []
		).flatMap((row) =>
			Number.isSafeInteger(row.tournament_id) && Number(row.tournament_id) > 0
				? [{ tournament_id: Number(row.tournament_id) }]
				: []
		);
		const tournamentIds = extractTournamentIds([
			...((rosterMemberships.data as DbTournamentEntryRow[] | null) ?? []),
			...canonicalTournamentIds,
		]);
		const tournaments = (await getTournamentInfosUncached(context, tournamentIds)).filter(
			isOfficialH2HInfo
		);
		if (tournaments.length === 0) return [];

		const eventResult = await context.data
			.read("fpl.events")
			.select("id, finished, data_checked, is_current, is_next")
			.order("id", { ascending: true });
		if (eventResult.error) throw new Error("Failed to resolve the H2H desk event");
		const events = (eventResult.data as DbEventStateRow[] | null) ?? [];
		const currentEvent =
			events.find((event) => event.is_current) ?? events.find((event) => event.is_next);
		if (!currentEvent) return [];
		const referenceEventId = resolveOfficialH2HReferenceEventId(events);
		const finalizedEventIds = new Set(
			events.filter((event) => event.finished && event.data_checked).map((event) => event.id)
		);
		const loadedOfficialH2H = await applyActiveOfficialH2HScoreAuthority(
			context,
			await loadOfficialH2HSnapshots(
				context,
				tournaments,
				currentEvent.id,
				referenceEventId,
				true,
				finalizedEventIds
			),
			currentEvent.id,
			finalizedEventIds
		);
		const bulkRows: EntryOfficialH2HDeskItem[] = [];
		for (const tournament of tournaments) {
			const loadedSnapshot = loadedOfficialH2H.get(tournament.id);
			if (!loadedSnapshot) continue;
			const {
				snapshot,
				history,
				standingsPublished,
				currentEventComplete,
				validatedFinalizedEventIds,
			} = loadedSnapshot;
			const standing = snapshot.standings.find((row) => row.entryId === entryId);
			const matches = snapshot.matches.filter(
				(candidate) => candidate.home.entryId === entryId || candidate.away.entryId === entryId
			);
			const projectedPreviousStandings = projectHistoricalOfficialH2HStandings(
				snapshot.standings.map((row) => row.entryId),
				history.filter((row) => row.event_id < currentEvent.id),
				{
					finalizedEventIds: validatedFinalizedEventIds,
					suppressedEventIds: rejectedFinalizedOfficialH2HEventIds(
						finalizedEventIds,
						validatedFinalizedEventIds
					),
				}
			);
			const previousStandings = projectedPreviousStandings.some((row) => row.played > 0)
				? projectedPreviousStandings
				: [];
			bulkRows.push({
				tournamentId: tournament.id,
				tournamentName: tournament.name,
				totalTeams: tournament.totalTeamNum,
				eventId: currentEvent.id,
				awaitingSchedule: snapshot.awaitingSchedule,
				isLive: currentEvent.is_current && !currentEvent.finished,
				isFinal: currentEvent.finished && currentEvent.data_checked,
				scoreSource: snapshot.scoreSource,
				scoreRevision: snapshot.scoreRevision,
				scoreCheckedAt: snapshot.scoreCheckedAt,
				rank: standing?.rank ?? null,
				lastRank: previousStandings.find((row) => row.entryId === entryId)?.rank ?? null,
				matchPoints: standing?.matchPoints ?? 0,
				standingsPublished,
				standingsCurrentEventComplete: currentEventComplete,
				match: matches.find((match) => match.phase === "REGULAR") ?? matches[0] ?? null,
				matches,
			});
		}
		if (loadedOfficialH2H.size === tournaments.length) {
			return bulkRows.sort(
				(left, right) =>
					Number(right.isLive) - Number(left.isLive) ||
					left.tournamentName.localeCompare(right.tournamentName)
			);
		}

		const rows: EntryOfficialH2HDeskItem[] = [];
		for (const tournament of tournaments) {
			const snapshot = await tournamentsRepository.getTournamentOfficialH2H(
				context,
				tournament.id,
				currentEvent.id
			);
			const standing = snapshot.standings.find((row) => row.entryId === entryId);
			const match = snapshot.matches.find(
				(candidate) => candidate.home.entryId === entryId || candidate.away.entryId === entryId
			);
			rows.push({
				tournamentId: tournament.id,
				tournamentName: tournament.name,
				totalTeams: tournament.totalTeamNum,
				eventId: currentEvent.id,
				awaitingSchedule: snapshot.awaitingSchedule,
				isLive: currentEvent.is_current && !currentEvent.finished,
				isFinal: currentEvent.finished && currentEvent.data_checked,
				scoreSource: snapshot.scoreSource,
				scoreRevision: snapshot.scoreRevision,
				scoreCheckedAt: snapshot.scoreCheckedAt,
				rank: standing?.rank ?? null,
				lastRank: null,
				matchPoints: standing?.matchPoints ?? 0,
				standingsPublished: false,
				standingsCurrentEventComplete: false,
				match: match ?? null,
				matches: match ? [match] : [],
			});
		}
		return rows.sort(
			(left, right) =>
				Number(right.isLive) - Number(left.isLive) ||
				left.tournamentName.localeCompare(right.tournamentName)
		);
	},

	async getTournamentDetailDesk(
		context: GraphQLContext,
		tournamentId: number,
		entryId: number,
		eventId?: number | null
	): Promise<TournamentDetailDesk | null> {
		if (
			// Detail clients use this as a bounded route parameter, never as a
			// publication lookup escape hatch.
			eventId !== null &&
			eventId !== undefined &&
			(!Number.isSafeInteger(eventId) || eventId < 1 || eventId > 38)
		) {
			throw new GraphQLError("Requested event is invalid", {
				extensions: { code: "BAD_USER_INPUT" },
			});
		}
		const tournament = await getTournamentInfoUncached(context, tournamentId);
		if (!tournament) return null;
		const eventContext = await eventsService.getLightweightCoreEventContext(context);
		const activeEventId =
			eventContext.currentEventId ?? eventContext.nextEventId ?? eventContext.latestFinishedEventId;
		const requestedEventId = eventId ?? activeEventId ?? 1;
		const isOfficial = isOfficialH2HInfo(tournament);
		const kind: TournamentDetailDesk["kind"] =
			tournament.setupStatus !== TournamentSetupStatus.READY
				? "setup"
				: isOfficial
					? "official_h2h"
					: "live_points";
		let participants: TournamentParticipant[] = [];
		let unavailableSections: string[] = [];
		try {
			participants = await tournamentsRepository.getTournamentParticipants(context, tournamentId);
		} catch (error) {
			context.logger.warn(
				{ err: error, section: "participants" },
				"Tournament detail participants unavailable"
			);
			unavailableSections = ["PARTICIPANTS"];
		}
		let officialH2H: TournamentOfficialH2H | null = null;
		let live: TournamentDetailDesk["live"] = null;
		if (kind === "official_h2h") {
			officialH2H = await tournamentsRepository.getTournamentOfficialH2H(
				context,
				tournamentId,
				requestedEventId
			);
		} else if (kind === "live_points") {
			const eventCore = await getCoreEventSnapshot(context);
			const event = eventCore.events.find((candidate) => candidate.id === requestedEventId);
			// Before the first deadline there is no live publication to load. Keep
			// the desk truthful and render the scheduled empty board instead.
			const scheduled =
				event !== undefined &&
				!event.finished &&
				!event.isCurrent &&
				(eventCore.currentEventId === null || event.id > eventCore.currentEventId);
			if (scheduled) {
				live = {
					eventId: requestedEventId,
					revision: `scheduled-${eventCore.revision}`,
					state: "SCHEDULED",
					partial: false,
					failedEntryIds: [],
					totalEntries: tournament.totalTeamNum,
					rows: [],
				};
			} else {
				const snapshot = await getLiveDataSnapshot(context, requestedEventId).catch((error) => {
					context.logger.info(
						{
							eventId: requestedEventId,
							err: error instanceof Error ? error.message : "unknown",
						},
						"Tournament live publication unavailable; calculating the durable manager board"
					);
					return null;
				});
				// Provisional live points can change when the core event flips to
				// finished/data_checked. Only final scoring boards are reusable.
				const scoringPhase = event?.finished === true && event.dataChecked === true;
				const currentRosterEntryIds = await tournamentsRepository.getTournamentEntryIdsUncached(
					context,
					tournamentId
				);
				const eligibility = await loadTournamentEventEligibility(
					currentRosterEntryIds,
					requestedEventId,
					(entryIds) => entriesService.getEntriesByIds(context, entryIds)
				);
				const rosterEntryIds = eligibility.entryIds;
				const { entryIds: boundedEntryIds, deferredEntryIds } = selectTournamentDeskEntryWindow(
					rosterEntryIds,
					entryId
				);
				const liveCacheKey =
					scoringPhase && snapshot
						? competitionBoardCacheKey(context, snapshot, tournamentId)
						: null;
				// A finalized board with deferred rows is viewer-specific because the
				// bounded window retains the requesting manager. Do not read or write
				// the shared event/tournament cache for that shape.
				const cachedCandidate =
					liveCacheKey && deferredEntryIds.length === 0
						? await readCompetitionBoardCache(context, liveCacheKey)
						: null;
				const cachedRows = cachedCandidate?.board as
					| Array<{
							entry: number;
							score?: { source?: string; state?: string };
					  }>
					| undefined;
				const cachedBoard =
					cachedCandidate && cachedRows && managerScoreBoardIsFinal(cachedRows)
						? cachedCandidate
						: null;
				const cached = cachedBoard
					? {
							rows: cachedBoard.board as LiveCalcData[],
							partial: cachedBoard.partial,
							failedEntryIds: cachedBoard.failedEntryIds,
							totalEntries: cachedBoard.totalEntries,
						}
					: null;
				const result = cached
					? null
					: await entryLiveBatchService.calcLivePointsForEntries(
							context,
							requestedEventId,
							boundedEntryIds,
							{
								entriesById: eligibility.entriesById,
								tournamentId,
								...(snapshot?.publicationId
									? {
											liveRef: {
												publicationId: snapshot.publicationId,
												revision: snapshot.revision,
											},
										}
									: {}),
							}
						);
				const liveData = cached ?? {
					rows: rankTournamentRowsByOfficialEventPoints(Array.from(result?.results.values() ?? [])),
					partial: (result?.errors.length ?? 0) > 0 || deferredEntryIds.length > 0,
					failedEntryIds: [
						...(result?.errors.map((error) => error.entryId) ?? []),
						...deferredEntryIds,
					],
					totalEntries: rosterEntryIds.length,
				};
				live = {
					eventId: requestedEventId,
					revision: snapshot?.revision ?? null,
					state: snapshot?.state.toUpperCase() ?? (scoringPhase ? "SETTLED" : "LIVE"),
					...liveData,
				};
				if (
					liveCacheKey &&
					!cached &&
					result &&
					deferredEntryIds.length === 0 &&
					result.errors.length === 0 &&
					managerScoreBoardIsFinal(liveData.rows)
				) {
					await writeCompetitionBoardCache(
						context,
						liveCacheKey,
						{
							board: liveData.rows,
							partial: liveData.partial,
							failedEntryIds: liveData.failedEntryIds,
							totalEntries: liveData.totalEntries,
						},
						24 * 60 * 60
					);
				}
			}
		}
		const officialSourceCheckedAt =
			officialH2H?.matches
				.map((match) => match.sourceCheckedAt)
				.filter((value): value is string => Boolean(value))
				.sort()
				.at(-1) ?? tournament.updatedAt;
		return {
			tournament,
			viewerEntryId: entryId,
			canManage: tournament.adminEntryId === entryId || hasPlatformAdminAccess(context, entryId),
			participants,
			unavailableSections,
			setup:
				kind === "setup"
					? {
							status: tournament.setupStatus,
							phase: tournament.setupPhase ?? TournamentSetupPhase.QUEUED,
							completedUnits: tournament.setupCompletedUnits ?? 0,
							totalUnits: tournament.setupTotalUnits ?? 0,
							hasWarnings: tournament.setupHasWarnings ?? false,
							progressMode: tournament.setupProgressMode ?? TournamentSetupProgressMode.DETERMINATE,
							attempt: tournament.setupAttempt ?? 0,
							maxAttempts: tournament.setupMaxAttempts ?? 3,
							nextRetryAt: tournament.nextRetryAt ?? null,
							warningSummaries: tournament.warningSummaries ?? [],
							__tournamentId: tournament.id,
						}
					: null,
			officialH2H,
			live,
			revision: isOfficial
				? `official:${tournament.officialScheduleHash ?? "none"}:${officialSourceCheckedAt}`
				: live
					? `${tournament.updatedAt}:${eventContext.revision}:live-${live.revision ?? `durable-${requestedEventId}`}`
					: `${tournament.updatedAt}:${eventContext.revision}`,
			kind,
			context: {
				season: context.currentSeason.seasonCode,
				coreRevision: eventContext.revision,
				activeEventId,
				requestedEventId,
			},
		};
	},

	async getManagedTournamentStatus(
		context: GraphQLContext,
		tournamentId: number,
		entryId: number
	): Promise<ManagedTournamentStatus | null> {
		const query = context.data
			.read("competition.tournaments")
			.select(
				"id, admin_entry_id, state, setup_status, setup_phase, roster_sync_status, setup_completed_units, setup_total_units, setup_progress_indeterminate, setup_attempt, setup_max_attempts, setup_next_retry_at, standings_ready_at, profiles_ready_at, insights_ready_at, setup_warning_count, updated_at"
			)
			.eq("id", tournamentId);
		if (!hasPlatformAdminAccess(context, entryId)) query.eq("admin_entry_id", entryId);
		const tournament = await query.limit(1);
		if (tournament.error) throw new Error("Failed to fetch tournament status");
		const row = tournament.data?.[0] as Record<string, unknown> | undefined;
		if (!row) return null;
		const setupStatus = String(row.setup_status) as TournamentSetupStatus;
		const updatedAt = toIsoDateTime(row.updated_at);
		const issues = await getTournamentSetupIssueDiagnostics(context, tournamentId);
		const warningSummaries = summarizeTournamentSetupIssues(issues);
		return {
			revision: updatedAt,
			state: String(row.state) as TournamentState,
			setupStatus,
			setupPhase: String(
				row.setup_phase ??
					(setupStatus === TournamentSetupStatus.READY
						? TournamentSetupPhase.READY
						: TournamentSetupPhase.QUEUED)
			) as TournamentSetupPhase,
			rosterSyncStatus: row.roster_sync_status
				? (String(row.roster_sync_status) as TournamentSetupStatus)
				: null,
			setupCompletedUnits: Number(row.setup_completed_units ?? 0),
			setupTotalUnits: Number(row.setup_total_units ?? 0),
			setupProgressMode: row.setup_progress_indeterminate
				? TournamentSetupProgressMode.INDETERMINATE
				: TournamentSetupProgressMode.DETERMINATE,
			setupAttempt: Number(row.setup_attempt ?? 0),
			setupMaxAttempts: Number(row.setup_max_attempts ?? 3),
			nextRetryAt: toNullableIsoDateTime(row.setup_next_retry_at),
			standingsReadyAt: toNullableIsoDateTime(row.standings_ready_at),
			profilesReadyAt: toNullableIsoDateTime(row.profiles_ready_at),
			insightsReadyAt: toNullableIsoDateTime(row.insights_ready_at),
			setupHasWarnings: Number(row.setup_warning_count ?? 0) > 0,
			warningSummaries,
			issues,
			updatedAt,
		};
	},
};
