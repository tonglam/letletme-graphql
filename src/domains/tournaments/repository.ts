import type { GraphQLContext } from "../../graphql/context";
import { gqlCacheKey } from "../../infra/cache-key";
import { env } from "../../infra/env";
import { getCurrentSeason } from "../../infra/season";
import { stableStringify } from "../../infra/stringify";
import { LeagueType } from "../leagues/repository";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const readJsonCache = async (
	context: GraphQLContext,
	key: string,
	validate: (value: unknown) => boolean = () => true
): Promise<unknown | undefined> => {
	let raw: string | null;
	try {
		raw = await context.redis.get(key);
	} catch (error) {
		context.logger.warn({ err: error, key }, "Failed to read tournaments cache");
		return undefined;
	}
	if (raw === null) return undefined;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (validate(parsed)) return parsed;
		context.logger.warn({ key }, "Invalid shaped tournaments cache");
	} catch (error) {
		context.logger.warn({ err: error, key }, "Malformed tournaments cache");
		try {
			await context.redis.del(key);
		} catch (evictionError) {
			context.logger.warn(
				{ err: evictionError, key },
				"Failed to evict malformed tournaments cache"
			);
		}
		return undefined;
	}
};

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

export enum TournamentRosterMode {
	SNAPSHOT = "snapshot",
	OFFICIAL_SYNC = "official_sync",
}

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
	setupStatus?: TournamentSetupStatus;
	setupPhase?: TournamentSetupPhase;
	setupCompletedUnits?: number;
	setupTotalUnits?: number;
	setupProgressUpdatedAt?: string | null;
	standingsReadyAt?: string | null;
	setupHasWarnings?: boolean;
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
	roster_last_synced_at?: string | null;
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
	setup_status?: string;
	setup_phase?: string;
	setup_completed_units?: number;
	setup_total_units?: number;
	setup_progress_updated_at?: string | null;
	standings_ready_at?: string | null;
	setup_warning_count?: number;
	setup_started_at?: string | null;
	setup_finished_at?: string | null;
	created_at: string;
	updated_at: string;
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
	_tournament_created_at: string;
	_tournament_updated_at: string;
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
	home_entry_id: number;
	home_net_points: number | null;
	home_rank: number | null;
	home_match_points: number | null;
	away_entry_id: number;
	away_net_points: number | null;
	away_rank: number | null;
	away_match_points: number | null;
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

type DbTournamentEventSnapshotRow = {
	tournament_id: number;
	event_id: number;
	entry_id: number;
	tournament_overall_rank: number | null;
	overall_rank: number | null;
	team_value: number | null;
	cum_transfers_num: number;
	cum_total_costs: number;
	cum_total_bench_points: number;
	cum_auto_sub_points: number;
	tournament_team_value_rank: number | null;
	tournament_transfers_rank: number | null;
	tournament_costs_rank: number | null;
	tournament_bench_points_rank: number | null;
	tournament_auto_sub_rank: number | null;
};

const isTournamentInfoCache = (value: unknown): value is TournamentInfo =>
	isRecord(value) &&
	Number.isFinite(Number(value.id)) &&
	typeof value.name === "string" &&
	typeof value.setupStatus === "string" &&
	typeof value.setupPhase === "string" &&
	Number.isFinite(Number(value.setupCompletedUnits)) &&
	Number.isFinite(Number(value.setupTotalUnits)) &&
	typeof value.setupHasWarnings === "boolean" &&
	"standingsReadyAt" in value &&
	typeof value.rosterMode === "string";

const isTournamentInfoArrayCache = (value: unknown): value is TournamentInfo[] =>
	Array.isArray(value) && value.every(isTournamentInfoCache);

const isEntryIdArrayCache = (value: unknown): value is number[] =>
	Array.isArray(value) &&
	value.every((item) => Number.isSafeInteger(Number(item)) && Number(item) > 0);

const isTournamentEventResultArrayCache = (value: unknown): value is TournamentEventResult[] =>
	Array.isArray(value) &&
	value.every(
		(item) =>
			isRecord(item) &&
			Number.isFinite(Number(item.eventId)) &&
			Number.isFinite(Number(item.entryId)) &&
			isTournamentInfoCache(item.tournament)
	);

const isRankingSummaryCache = (value: unknown): value is TournamentEntryRankingSummary =>
	isRecord(value) &&
	Number.isFinite(Number(value.eventId)) &&
	Number.isFinite(Number(value.entryId));

const isBattleResultArrayCache = (value: unknown): value is TournamentBattleGroupResult[] =>
	Array.isArray(value) &&
	value.every(
		(item) =>
			isRecord(item) &&
			Number.isFinite(Number(item.matchId)) &&
			isTournamentInfoCache(item.tournament)
	);

const isH2HResultArrayCache = (value: unknown): value is EntryH2HMatchResult[] =>
	Array.isArray(value) &&
	value.every((item) => isRecord(item) && isTournamentInfoCache(item.tournament));

const TOURNAMENT_INFO_COLUMNS =
	"id, name, creator, admin_entry_id, league_id, league_type, source_league_name, roster_mode, roster_sync_status, roster_last_synced_at, total_team_num, tournament_mode, group_mode, group_team_num, group_num, group_started_event_id, group_ended_event_id, group_auto_averages, group_rounds, group_play_against_num, group_qualify_num, knockout_mode, knockout_team_num, knockout_rounds, knockout_event_num, knockout_started_event_id, knockout_ended_event_id, knockout_play_against_num, state, setup_status, setup_phase, setup_completed_units, setup_total_units, setup_progress_updated_at, standings_ready_at, setup_warning_count, setup_started_at, setup_finished_at, created_at, updated_at";

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

const mapTournamentSetupStatus = (status: string | null | undefined): TournamentSetupStatus => {
	if (status === TournamentSetupStatus.PENDING) return TournamentSetupStatus.PENDING;
	if (status === TournamentSetupStatus.PROCESSING) return TournamentSetupStatus.PROCESSING;
	if (status === TournamentSetupStatus.FAILED) return TournamentSetupStatus.FAILED;
	return TournamentSetupStatus.READY;
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
	rosterLastSyncedAt: row.roster_last_synced_at ?? null,
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
	setupProgressUpdatedAt: row.setup_progress_updated_at ?? null,
	standingsReadyAt:
		row.standings_ready_at ?? (row.setup_status === undefined ? row.updated_at : null),
	setupHasWarnings: (row.setup_warning_count ?? 0) > 0,
	setupStartedAt: row.setup_started_at ?? null,
	setupFinishedAt: row.setup_finished_at ?? null,
	createdAt: row.created_at,
	updatedAt: row.updated_at,
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
	eventChip: leagueEventRow?.event_chip ?? null,
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
	standingsReadyAt: row._tournament_updated_at,
	setupHasWarnings: false,
	setupStartedAt: null,
	setupFinishedAt: row._tournament_updated_at,
	createdAt: row._tournament_created_at,
	updatedAt: row._tournament_updated_at,
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
	eventChip: row.event_chip,
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
		entryChip: myEvent?.event_chip ?? null,
		opponentEntryId: oppEntryId,
		opponentEntryName: oppName?.entry_name ?? null,
		opponentPlayerName: oppName?.player_name ?? null,
		opponentNetPoints: isHome ? row.away_net_points : row.home_net_points,
		opponentRank: isHome ? row.away_rank : row.home_rank,
		opponentMatchPoints: isHome ? row.away_match_points : row.home_match_points,
		opponentEventPoints: oppEvent?.event_points ?? null,
		opponentTransferCost: oppEvent?.event_transfers_cost ?? null,
		opponentOverallRank: oppEvent?.overall_rank ?? null,
		opponentChip: oppEvent?.event_chip ?? null,
	};
};

const getTournamentInfoUncached = async (
	context: GraphQLContext,
	tournamentId: number
): Promise<TournamentInfo | null> => {
	const { data, error } = await context.supabase
		.from("tournament_infos")
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

	const { data, error } = await context.supabase
		.from("tournament_infos")
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
): Promise<TournamentInfo | null> => {
	const season = await getCurrentSeason(context);
	const cacheKey = gqlCacheKey(season, `tournament:info:${tournamentId}`);
	const cached = await readJsonCache(context, cacheKey, isTournamentInfoCache);
	if (isRecord(cached) && Number.isFinite(Number(cached.id))) {
		return cached as unknown as TournamentInfo;
	}

	const tournament = await getTournamentInfoUncached(context, tournamentId);
	if (!tournament) return null;
	await context.redis.set(cacheKey, JSON.stringify(tournament), "EX", env.CACHE_TTL_SECONDS);
	return tournament;
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
		eventId: number
	): Promise<TournamentEventResult[]>;
	getTournamentEntryRankingSummary(
		context: GraphQLContext,
		tournamentId: number,
		eventId: number,
		entryId: number
	): Promise<TournamentEntryRankingSummary>;
	getTournamentBattleGroupResults(
		context: GraphQLContext,
		tournamentId: number,
		eventId: number
	): Promise<TournamentBattleGroupResult[]>;
	getEntryH2HMatchResults(context: GraphQLContext, entryId: number): Promise<EntryH2HMatchResult[]>;
}

export const tournamentsRepository: TournamentsRepository = {
	getTournamentInfoUncached,
	getTournamentInfosUncached,

	async getTournamentForMember(
		context: GraphQLContext,
		tournamentId: number,
		entryId: number
	): Promise<TournamentInfo | null> {
		const { data, error } = await context.supabase
			.from("tournament_entries")
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
		const { data, error } = await context.supabase
			.from("tournament_infos")
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
		const { data: membershipData, error: membershipError } = await context.supabase
			.from("tournament_entries")
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

		const { data: entryData, error: entryError } = await context.supabase
			.from("entry_infos")
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
		const season = await getCurrentSeason(context);
		const cacheKey = gqlCacheKey(season, `tournaments:entry:${entryId}`);
		const cached = await readJsonCache(context, cacheKey, isTournamentInfoArrayCache);
		if (
			Array.isArray(cached) &&
			cached.every((item) => isRecord(item) && Number.isFinite(Number(item.id)))
		) {
			return cached as TournamentInfo[];
		}

		const { data: entryData, error: entryError } = await context.supabase
			.from("tournament_entries")
			.select("tournament_id")
			.eq("entry_id", entryId);

		if (entryError) {
			context.logger.error({ err: entryError, entryId }, "Failed to fetch tournament memberships");
			throw new Error("Failed to fetch tournament memberships");
		}

		const tournamentIds = extractTournamentIds((entryData as DbTournamentEntryRow[] | null) ?? []);
		if (tournamentIds.length === 0) {
			await context.redis.set(cacheKey, JSON.stringify([]), "EX", env.CACHE_TTL_SECONDS);
			return [];
		}

		const { data: infoData, error: infoError } = await context.supabase
			.from("tournament_infos")
			.select(TOURNAMENT_INFO_COLUMNS)
			.in("id", tournamentIds)
			.order("id", { ascending: true });

		if (infoError) {
			context.logger.error({ err: infoError, entryId }, "Failed to fetch tournament details");
			throw new Error("Failed to fetch tournament details");
		}

		const tournaments = ((infoData as DbTournamentInfoRow[] | null) ?? []).map(mapTournamentInfo);
		await context.redis.set(cacheKey, JSON.stringify(tournaments), "EX", env.CACHE_TTL_SECONDS);
		return tournaments;
	},

	async getTournamentEntryIds(context: GraphQLContext, tournamentId: number): Promise<number[]> {
		const season = await getCurrentSeason(context);
		const cacheKey = gqlCacheKey(season, `tournaments:entry-ids:${tournamentId}`);
		const cached = await readJsonCache(context, cacheKey, isEntryIdArrayCache);
		if (Array.isArray(cached) && cached.every((item) => Number.isFinite(Number(item)))) {
			return cached as number[];
		}

		const entryIds = await tournamentsRepository.getTournamentEntryIdsUncached(
			context,
			tournamentId
		);
		await context.redis.set(cacheKey, JSON.stringify(entryIds), "EX", env.CACHE_TTL_SECONDS);
		return entryIds;
	},

	async getTournamentEntryIdsUncached(
		context: GraphQLContext,
		tournamentId: number
	): Promise<number[]> {
		const { data, error } = await context.supabase
			.from("tournament_entries")
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
		eventId: number
	): Promise<TournamentEventResult[]> {
		const season = await getCurrentSeason(context);
		const cacheKey = gqlCacheKey(
			season,
			`tournaments:event-results:${stableStringify({ tournamentId, eventId })}`
		);
		const cached = await readJsonCache(context, cacheKey, isTournamentEventResultArrayCache);
		if (
			Array.isArray(cached) &&
			cached.every(
				(item) =>
					isRecord(item) &&
					Number.isFinite(Number(item.eventId)) &&
					Number.isFinite(Number(item.entryId))
			)
		) {
			return cached as TournamentEventResult[];
		}

		const { data: resultData, error: resultError } = await context.supabase
			.from("v_tournament_event_result")
			.select(TOURNAMENT_VIEW_COLUMNS)
			.eq("tournament_id", tournamentId)
			.eq("event_id", eventId)
			.order("group_id", { ascending: true })
			.order("event_group_rank", { ascending: true, nullsFirst: false })
			.order("entry_id", { ascending: true });

		if (resultError) {
			context.logger.error(
				{ err: resultError, tournamentId, eventId },
				"Failed to fetch tournament event results"
			);
			throw new Error("Failed to fetch tournament event results");
		}

		const rows = (resultData as DbTournamentEventResultRow[] | null) ?? [];
		if (rows.length === 0) {
			await context.redis.set(cacheKey, JSON.stringify([]), "EX", env.CACHE_TTL_SECONDS);
			return [];
		}

		const tournament = await getTournamentInfoById(context, tournamentId);
		if (!tournament) return [];
		if (tournament.groupMode !== GroupMode.POINTS_RACES) {
			context.logger.warn(
				{ tournamentId, groupMode: tournament.groupMode },
				"Tournament event results only supported for POINTS_RACES; returning empty"
			);
			await context.redis.set(cacheKey, JSON.stringify([]), "EX", env.CACHE_TTL_SECONDS);
			return [];
		}

		const results = rows.map((row) => mapTournamentEventResultFromView(tournament, row));

		await context.redis.set(cacheKey, JSON.stringify(results), "EX", env.CACHE_TTL_SECONDS);
		return results;
	},

	async getTournamentEntryRankingSummary(
		context: GraphQLContext,
		tournamentId: number,
		eventId: number,
		entryId: number
	): Promise<TournamentEntryRankingSummary> {
		const season = await getCurrentSeason(context);
		const cacheKey = gqlCacheKey(
			season,
			`tournaments:ranking-summary:${stableStringify({
				tournamentId,
				eventId,
				entryId,
			})}`
		);
		const cached = await readJsonCache(context, cacheKey, isRankingSummaryCache);
		if (
			isRecord(cached) &&
			Number.isFinite(Number(cached.eventId)) &&
			Number.isFinite(Number(cached.entryId))
		) {
			return cached as unknown as TournamentEntryRankingSummary;
		}

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
		};

		const [tournament, snapshotResponse] = await Promise.all([
			getTournamentInfoById(context, tournamentId),
			context.supabase
				.from("mv_tournament_event_snapshot")
				.select(
					"tournament_id, event_id, entry_id, tournament_overall_rank, overall_rank, team_value, cum_transfers_num, cum_total_costs, cum_total_bench_points, cum_auto_sub_points, tournament_team_value_rank, tournament_transfers_rank, tournament_costs_rank, tournament_bench_points_rank, tournament_auto_sub_rank"
				)
				.eq("tournament_id", tournamentId)
				.eq("event_id", eventId)
				.eq("entry_id", entryId)
				.limit(1),
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

		const summary: TournamentEntryRankingSummary = {
			eventId,
			entryId,
			overallRank: snapshotRow?.overall_rank ?? null,
			tournamentOverallRank: snapshotRow?.tournament_overall_rank ?? null,
			teamValue: snapshotRow?.team_value ?? null,
			tournamentTeamValueRank: snapshotRow?.tournament_team_value_rank ?? null,
			transfersNum: snapshotRow?.cum_transfers_num ?? 0,
			tournamentTransfersRank: snapshotRow?.tournament_transfers_rank ?? null,
			totalCosts: snapshotRow?.cum_total_costs ?? 0,
			tournamentCostsRank: snapshotRow?.tournament_costs_rank ?? null,
			totalBenchPoints: snapshotRow?.cum_total_bench_points ?? 0,
			tournamentBenchPointsRank: snapshotRow?.tournament_bench_points_rank ?? null,
			autoSubPoints: snapshotRow?.cum_auto_sub_points ?? 0,
			tournamentAutoSubRank: snapshotRow?.tournament_auto_sub_rank ?? null,
		};

		await context.redis.set(cacheKey, JSON.stringify(summary), "EX", env.CACHE_TTL_SECONDS);
		return summary;
	},

	async getTournamentBattleGroupResults(
		context: GraphQLContext,
		tournamentId: number,
		eventId: number
	): Promise<TournamentBattleGroupResult[]> {
		const season = await getCurrentSeason(context);
		const cacheKey = gqlCacheKey(
			season,
			`tournaments:battle-results:${stableStringify({ tournamentId, eventId })}`
		);
		const cached = await readJsonCache(context, cacheKey, isBattleResultArrayCache);
		if (
			Array.isArray(cached) &&
			cached.every((item) => isRecord(item) && Number.isFinite(Number(item.eventId)))
		) {
			return cached as TournamentBattleGroupResult[];
		}

		const [tournamentResult, matchResult, entryIds] = await Promise.all([
			getTournamentInfoById(context, tournamentId),
			context.supabase
				.from("tournament_battle_group_results")
				.select(
					"id, tournament_id, group_id, event_id, home_entry_id, home_net_points, home_rank, home_match_points, away_entry_id, away_net_points, away_rank, away_match_points"
				)
				.eq("tournament_id", tournamentId)
				.eq("event_id", eventId)
				.order("group_id", { ascending: true })
				.order("home_entry_id", { ascending: true }),
			tournamentsRepository.getTournamentEntryIds(context, tournamentId),
		]);

		if (matchResult.error) {
			context.logger.error(
				{ err: matchResult.error, tournamentId, eventId },
				"Failed to fetch tournament battle group results"
			);
			throw new Error("Failed to fetch tournament battle group results");
		}

		const rows = (matchResult.data as DbTournamentBattleGroupResultRow[] | null) ?? [];
		if (rows.length === 0 || !tournamentResult) {
			await context.redis.set(cacheKey, JSON.stringify([]), "EX", env.CACHE_TTL_SECONDS);
			return [];
		}

		const { data: nameData } = await context.supabase
			.from("entry_infos")
			.select("id, entry_name, player_name")
			.in("id", entryIds);

		const entryNameMap = new Map<number, DbEntryInfoNameRow>(
			((nameData as DbEntryInfoNameRow[] | null) ?? []).map((r) => [r.id, r])
		);

		const results = rows.map((row) =>
			mapTournamentBattleGroupResult(tournamentResult, row, entryNameMap)
		);

		await context.redis.set(cacheKey, JSON.stringify(results), "EX", env.CACHE_TTL_SECONDS);
		return results;
	},

	async getEntryH2HMatchResults(
		context: GraphQLContext,
		entryId: number
	): Promise<EntryH2HMatchResult[]> {
		const season = await getCurrentSeason(context);
		// v2 is populated only after every represented tournament has published
		// standings. It deliberately bypasses partial/empty setup-era v1 values.
		const cacheKey = gqlCacheKey(season, `tournaments:entry-h2h:v2:${entryId}`);
		const cached = await readJsonCache(context, cacheKey, isH2HResultArrayCache);
		if (
			Array.isArray(cached) &&
			cached.every((item) => isRecord(item) && Number.isFinite(Number(item.eventId)))
		)
			return cached as EntryH2HMatchResult[];

		const { data: matchData, error: matchError } = await context.supabase
			.from("tournament_battle_group_results")
			.select(
				"id, tournament_id, group_id, event_id, home_entry_id, home_net_points, home_rank, home_match_points, away_entry_id, away_net_points, away_rank, away_match_points"
			)
			.or(`home_entry_id.eq.${entryId},away_entry_id.eq.${entryId}`)
			.order("event_id", { ascending: true })
			.order("tournament_id", { ascending: true });

		if (matchError) {
			context.logger.error({ err: matchError, entryId }, "Failed to fetch entry H2H match results");
			throw new Error("Failed to fetch entry H2H match results");
		}

		const rows = (matchData as DbTournamentBattleGroupResultRow[] | null) ?? [];
		if (rows.length === 0) {
			// During setup the battle rows may not exist yet. Do not turn that
			// transient absence into a cache entry that survives publication.
			return [];
		}

		const tournamentIds = [...new Set(rows.map((r) => r.tournament_id))];
		const tournamentInfos = await getTournamentInfosUncached(context, tournamentIds);
		const readyTournamentIds = new Set(
			tournamentInfos
				.filter((tournament) => tournament.standingsReadyAt)
				.map((tournament) => tournament.id)
		);
		const readyRows = rows.filter((row) => readyTournamentIds.has(row.tournament_id));
		if (readyRows.length === 0) return [];

		const eventIds = [...new Set(readyRows.map((r) => r.event_id))];
		const allEntryIds = [...new Set(readyRows.flatMap((r) => [r.home_entry_id, r.away_entry_id]))];

		const [nameResult, eventResultData] = await Promise.all([
			context.supabase
				.from("entry_infos")
				.select("id, entry_name, player_name")
				.in("id", allEntryIds),
			context.supabase
				.from("entry_event_results")
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
			await context.redis.set(cacheKey, JSON.stringify(results), "EX", env.CACHE_TTL_SECONDS);
		}
		return results;
	},
};
