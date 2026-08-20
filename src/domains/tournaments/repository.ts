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
import type { LiveCalcData } from "../entry-live/calc-service";
import {
	competitionBoardCacheKey,
	readCompetitionBoardCache,
	writeCompetitionBoardCache,
} from "../live-desks/competition-board-cache";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

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
		revision: string;
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
	source_checked_at?: string | null;
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
	rank: number | null;
	lastRank: number | null;
	matchPoints: number;
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
	source_checked_at: string | null;
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

export function projectHistoricalOfficialH2HStandings(
	entryIds: readonly number[],
	rows: readonly DbTournamentBattleGroupResultRow[]
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
		const sides = [
			{
				entryId: row.home_entry_id,
				points: row.home_net_points,
				matchPoints: row.home_match_points,
			},
			{
				entryId: row.away_entry_id,
				points: row.away_net_points,
				matchPoints: row.away_match_points,
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

function mapOfficialBattleMatch(
	row: DbTournamentBattleGroupResultRow,
	entryNames: Map<number, DbEntryInfoNameRow>
): OfficialH2HMatch {
	if (
		row.official_match_id === null ||
		row.official_match_id === undefined ||
		row.source_order === null ||
		row.source_order === undefined
	) {
		throw new Error("Official H2H battle row is missing source identity");
	}
	const winnerEntryId =
		row.home_match_points === 3
			? row.home_entry_id
			: row.away_match_points === 3
				? row.away_entry_id
				: null;
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
			row.home_net_points,
			row.home_match_points,
			entryNames
		),
		away: officialMatchSide(
			row.away_entry_id,
			row.away_is_average ?? row.away_entry_id === null,
			row.away_net_points,
			row.away_match_points,
			entryNames
		),
		winnerEntryId,
		tiebreak: null,
		sourceCheckedAt: row.source_checked_at ?? null,
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
		sourceCheckedAt: row.source_checked_at,
	};
}

function isOfficialH2HInfo(tournament: TournamentInfo): boolean {
	return (
		tournament.leagueType === LeagueType.H2H &&
		tournament.rosterMode === TournamentRosterMode.OFFICIAL_SYNC &&
		tournament.groupMode === GroupMode.BATTLE_RACES
	);
}

type OfficialH2HSnapshotLoad = {
	snapshot: TournamentOfficialH2H;
	history: DbTournamentBattleGroupResultRow[];
};

async function loadOfficialH2HSnapshots(
	context: GraphQLContext,
	tournaments: readonly TournamentInfo[],
	eventId: number,
	activeEventId: number,
	includeHistory: boolean
): Promise<Map<number, OfficialH2HSnapshotLoad>> {
	const tournamentIds = tournaments.map((tournament) => tournament.id);
	const [groupResult, battleResult, knockoutResult] = await Promise.all([
		context.data
			.read("competition.tournament_groups")
			.select(
				"tournament_id, entry_id, group_points, group_rank, played, won, drawn, lost, total_net_points"
			)
			.in("tournament_id", tournamentIds)
			.order("group_rank", { ascending: true })
			.order("entry_id", { ascending: true }),
		context.data
			.read("competition.tournament_battle_group_results")
			.select(OFFICIAL_BATTLE_COLUMNS)
			.in("tournament_id", tournamentIds)
			.eq("event_id", eventId)
			.not("official_match_id", "is", null)
			.order("event_id", { ascending: true })
			.order("source_order", { ascending: true })
			.order("official_match_id", { ascending: true }),
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

	let historyRows: DbTournamentBattleGroupResultRow[] = [];
	if (includeHistory) {
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

	const groups = (groupResult.data as DbTournamentGroupRow[] | null) ?? [];
	const battles = (battleResult.data as DbTournamentBattleGroupResultRow[] | null) ?? [];
	const knockouts = (knockoutResult.data as DbTournamentKnockoutResultRow[] | null) ?? [];
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
		const historicalStandings =
			eventId < activeEventId && includeHistory
				? projectHistoricalOfficialH2HStandings(
						tournamentGroups.map((row) => row.entry_id),
						tournamentHistory
					)
				: null;
		const matches = [
			...tournamentBattles.map((row) => mapOfficialBattleMatch(row, entryNames)),
			...tournamentKnockouts.map((row) => mapOfficialKnockoutMatch(row, entryNames)),
		].sort(
			(left, right) =>
				left.eventId - right.eventId ||
				left.sourceOrder - right.sourceOrder ||
				left.officialMatchId - right.officialMatchId
		);
		loaded.set(tournament.id, {
			snapshot: {
				tournament,
				eventId,
				awaitingSchedule:
					tournament.officialScheduleLockedAt === null ||
					tournament.officialScheduleLockedAt === undefined,
				standings: historicalStandings
					? historicalStandings.map((row) => ({
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
		});
	}
	return loaded;
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

const normalizeTournamentChip = (value: unknown): string | null => {
	if (typeof value !== "string") return null;
	const normalized = value.toUpperCase().trim();
	const compact = normalized.replace(/[^A-Z0-9]/g, "");
	if (
		normalized === "NONE" ||
		normalized === "NO_CHIP" ||
		compact === "NONE" ||
		compact === "NOCHIP"
	) {
		return "NONE";
	}
	if (
		normalized === "BENCH_BOOST" ||
		compact === "BENCHBOOST" ||
		compact === "BBOOST" ||
		compact === "BB"
	) {
		return "BENCH_BOOST";
	}
	if (
		normalized === "TRIPLE_CAPTAIN" ||
		compact === "TRIPLECAPTAIN" ||
		compact === "3XC" ||
		compact === "TC"
	) {
		return "TRIPLE_CAPTAIN";
	}
	if (normalized === "FREE_HIT" || compact === "FREEHIT" || compact === "FH") {
		return "FREE_HIT";
	}
	if (normalized === "WILDCARD" || compact === "WILDCARD" || compact === "WC") {
		return "WILDCARD";
	}
	if (normalized === "MANAGER" || compact === "MANAGER" || compact === "AM") {
		return "MANAGER";
	}
	return null;
};

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

export const extractTournamentIds = (rows: DbTournamentEntryRow[]): number[] => {
	const unique = new Set<number>();
	rows.forEach((row) => {
		unique.add(row.tournament_id);
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
	tournamentCacheKey,
};

export const tournamentsRepository: TournamentsRepository = {
	getTournamentInfoUncached,
	getTournamentInfosUncached,

	async getTournamentForMember(
		context: GraphQLContext,
		tournamentId: number,
		entryId: number
	): Promise<TournamentInfo | null> {
		const { data, error } = await context.data
			.read("competition.tournament_entries")
			.select("entry_id")
			.eq("tournament_id", tournamentId)
			.eq("entry_id", entryId)
			.limit(1);
		if (error) {
			context.logger.error({ err: error, tournamentId, entryId }, "Failed to verify membership");
			throw new Error("Failed to fetch tournament");
		}
		if (((data as { entry_id: number }[] | null) ?? []).length === 0) return null;
		return getTournamentInfoUncached(context, tournamentId);
	},

	async getManagedTournament(
		context: GraphQLContext,
		tournamentId: number,
		entryId: number
	): Promise<TournamentInfo | null> {
		const { data, error } = await context.data
			.read("competition.tournaments")
			.select(TOURNAMENT_INFO_COLUMNS)
			.eq("id", tournamentId)
			.eq("admin_entry_id", entryId)
			.limit(1);
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
		const cacheKey = context.dataRevision ? tournamentCacheKey(context, `entry:${entryId}`) : null;
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
		const { data: entryData, error: entryError } = await context.data
			.read("competition.tournament_entries")
			.select("tournament_id")
			.eq("entry_id", entryId);

		if (entryError) {
			context.logger.error({ err: entryError, entryId }, "Failed to fetch tournament memberships");
			throw new Error("Failed to fetch tournament memberships");
		}

		const tournamentIds = extractTournamentIds((entryData as DbTournamentEntryRow[] | null) ?? []);
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

		const { data: infoData, error: infoError } = await context.data
			.read("competition.tournaments")
			.select(TOURNAMENT_INFO_COLUMNS)
			.in("id", tournamentIds)
			.order("id", { ascending: true });

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
		const referenceEventId = resolveOfficialH2HReferenceEventId(
			(referenceEventResult.data as DbEventStateRow[] | null) ?? []
		);
		const loadedOfficialH2H = await loadOfficialH2HSnapshots(
			context,
			[tournament],
			eventId,
			referenceEventId,
			eventId < referenceEventId
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
		const historicalStandings =
			eventId < activeEventId
				? projectHistoricalOfficialH2HStandings(
						groups.map((row) => row.entry_id),
						history
					)
				: null;
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
			...battles.map((row) => mapOfficialBattleMatch(row, entryNames)),
			...knockouts.map((row) => mapOfficialKnockoutMatch(row, entryNames)),
		].sort(
			(left, right) =>
				left.eventId - right.eventId ||
				left.sourceOrder - right.sourceOrder ||
				left.officialMatchId - right.officialMatchId
		);
		return {
			tournament,
			eventId,
			awaitingSchedule:
				tournament.officialScheduleLockedAt === null ||
				tournament.officialScheduleLockedAt === undefined,
			standings: historicalStandings
				? historicalStandings.map((row) => ({
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
		};
	},

	async getEntryOfficialH2HDesk(
		context: GraphQLContext,
		entryId: number
	): Promise<EntryOfficialH2HDeskItem[]> {
		const membershipResult = await context.data
			.read("competition.tournament_entries")
			.select("tournament_id")
			.eq("entry_id", entryId);
		if (membershipResult.error) throw new Error("Failed to fetch official H2H memberships");
		const tournamentIds = extractTournamentIds(
			(membershipResult.data as DbTournamentEntryRow[] | null) ?? []
		);
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
		const loadedOfficialH2H = await loadOfficialH2HSnapshots(
			context,
			tournaments,
			currentEvent.id,
			referenceEventId,
			true
		);
		const bulkRows: EntryOfficialH2HDeskItem[] = [];
		for (const tournament of tournaments) {
			const loadedSnapshot = loadedOfficialH2H.get(tournament.id);
			if (!loadedSnapshot) continue;
			const { snapshot, history } = loadedSnapshot;
			const standing = snapshot.standings.find((row) => row.entryId === entryId);
			const matches = snapshot.matches.filter(
				(candidate) => candidate.home.entryId === entryId || candidate.away.entryId === entryId
			);
			const previousStandings = projectHistoricalOfficialH2HStandings(
				snapshot.standings.map((row) => row.entryId),
				history.filter((row) => row.event_id < currentEvent.id)
			);
			bulkRows.push({
				tournamentId: tournament.id,
				tournamentName: tournament.name,
				totalTeams: tournament.totalTeamNum,
				eventId: currentEvent.id,
				awaitingSchedule: snapshot.awaitingSchedule,
				isLive: currentEvent.is_current && !currentEvent.finished,
				isFinal: currentEvent.finished && currentEvent.data_checked,
				rank: standing?.rank ?? null,
				lastRank: previousStandings.find((row) => row.entryId === entryId)?.rank ?? null,
				matchPoints: standing?.matchPoints ?? 0,
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
				rank: standing?.rank ?? null,
				lastRank: null,
				matchPoints: standing?.matchPoints ?? 0,
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
				const snapshot = await getLiveDataSnapshot(context, requestedEventId);
				// Provisional live points can change when the core event flips to
				// finished/data_checked. Only final scoring boards are reusable.
				const scoringPhase = event?.finished === true && event.dataChecked === true;
				const liveCacheKey = scoringPhase
					? competitionBoardCacheKey(context, snapshot, tournamentId)
					: null;
				const cachedBoard = liveCacheKey
					? await readCompetitionBoardCache(context, liveCacheKey)
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
							await tournamentsRepository.getTournamentEntryIdsUncached(context, tournamentId),
							true,
							{ provisional: !(event?.finished && event.dataChecked) }
						);
				const liveData = cached ?? {
					rows: Array.from(result?.results.values() ?? []),
					partial: (result?.errors.length ?? 0) > 0,
					failedEntryIds: result?.errors.map((error) => error.entryId) ?? [],
					totalEntries: result?.meta.totalEntries ?? 0,
				};
				live = {
					eventId: requestedEventId,
					revision: snapshot.revision,
					state: snapshot.state.toUpperCase(),
					...liveData,
				};
				if (liveCacheKey && !cached && result && result.errors.length === 0) {
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
			canManage: tournament.adminEntryId === entryId,
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
					? `${tournament.updatedAt}:${eventContext.revision}:live-${live.revision}`
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
		const tournament = await context.data
			.read("competition.tournaments")
			.select(
				"id, admin_entry_id, state, setup_status, setup_phase, roster_sync_status, setup_completed_units, setup_total_units, setup_progress_indeterminate, setup_attempt, setup_max_attempts, setup_next_retry_at, standings_ready_at, profiles_ready_at, insights_ready_at, setup_warning_count, updated_at"
			)
			.eq("id", tournamentId)
			.eq("admin_entry_id", entryId)
			.limit(1);
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
