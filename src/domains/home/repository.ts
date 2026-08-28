import type { GraphQLContext } from "../../graphql/context";
import type { DataSqlContractProbe } from "../../contracts/data-sql-contract";
import {
	OfficialLeagueKind,
	mapFplOfficialKind,
	selectHomeLeagues,
} from "../leagues/display-order";

export type HomeRankDirection = "UP" | "DOWN" | "FLAT" | "UNKNOWN";
export type HomePersonalDeskState = "READY" | "EMPTY" | "STALE" | "UNAVAILABLE";
export type HomePointsState = "LIVE" | "STALE" | "SETTLING" | "FINAL" | "UNAVAILABLE";
export type HomeRankState = "READY" | "UPDATING" | "UNAVAILABLE";

export type HomeRankMovement = {
	direction: HomeRankDirection;
	places: number | null;
};

export type HomeH2HMatchupSide = {
	entryId: number | null;
	entryName: string | null;
	playerName: string | null;
	isAverage: boolean;
	points: number | null;
};

export type HomeH2HMatchup = {
	officialMatchId: number;
	eventId: number;
	isLive: boolean;
	isFinal: boolean;
	isBye: boolean;
	viewer: HomeH2HMatchupSide;
	opponent: HomeH2HMatchupSide;
	sourceCheckedAt: string | null;
};

export type HomeLeagueRank = {
	key: string;
	name: string;
	leagueType: "CLASSIC" | "H2H";
	visibility: "PRIVATE" | "PUBLIC";
	rank: number | null;
	rankState: HomeRankState;
	rankCheckedAt: string | null;
	movement: HomeRankMovement;
	tournamentId: number | null;
	h2hMatchup: HomeH2HMatchup | null;
};

export type HomePersonalDesk = {
	entryId: number;
	state: HomePersonalDeskState;
	entryName: string | null;
	playerName: string | null;
	region: string | null;
	overallPoints: number | null;
	pointsState: HomePointsState;
	pointsCheckedAt: string | null;
	overallRank: number | null;
	rankState: HomeRankState;
	rankCheckedAt: string | null;
	teamValue: number | null;
	bank: number | null;
	leagueRanks: HomeLeagueRank[];
	sourceCheckedAt: string | null;
};

type HomePersonalDeskRow = {
	entry_id: number;
	entry_name: string | null;
	player_name: string | null;
	region: string | null;
	overall_points: number | null;
	overall_rank: number | null;
	team_value: number | null;
	bank: number | null;
	source_checked_at: string | Date | null;
	league_id: number | null;
	league_type: string | null;
	league_name: string | null;
	entry_rank: number | null;
	entry_last_rank: number | null;
	league_source_checked_at: string | Date | null;
	league_started_event: number | null;
	official_kind: string | null;
	short_name: string | null;
	tournament_id: number | null;
	h2h_official_match_id: number | null;
	h2h_event_id: number | null;
	h2h_home_entry_id: number | null;
	h2h_home_entry_name: string | null;
	h2h_home_player_name: string | null;
	h2h_home_points: number | null;
	h2h_home_is_average: boolean | null;
	h2h_away_entry_id: number | null;
	h2h_away_entry_name: string | null;
	h2h_away_player_name: string | null;
	h2h_away_points: number | null;
	h2h_away_is_average: boolean | null;
	h2h_is_bye: boolean | null;
	h2h_source_checked_at: string | Date | null;
	h2h_reference_event_id: number | null;
	h2h_event_is_current: boolean | null;
	h2h_event_finished: boolean | null;
	h2h_event_data_checked: boolean | null;
};

const HOME_PERSONAL_STALE_AFTER_MS = 30 * 60 * 60 * 1000;

export const HOME_PERSONAL_DESK_SQL = `
	SELECT
		e.entry_id,
		e.entry_name,
		e.player_name,
		e.region,
		e.overall_points,
		e.overall_rank,
		e.team_value,
		e.bank,
		e.updated_at AS source_checked_at,
		l.league_id,
		l.league_type::text AS league_type,
		l.league_name,
		l.entry_rank,
		l.entry_last_rank,
		l.updated_at AS league_source_checked_at,
		l.started_event AS league_started_event,
		l.official_kind::text AS official_kind,
		l.short_name,
		COALESCE(official_h2h.tournament_id, tracked.tournament_id) AS tournament_id,
		h2h_match.official_match_id AS h2h_official_match_id,
		h2h_match.event_id AS h2h_event_id,
		h2h_match.home_entry_id AS h2h_home_entry_id,
		home_match_entry.entry_name AS h2h_home_entry_name,
		home_match_entry.player_name AS h2h_home_player_name,
		h2h_match.home_points AS h2h_home_points,
		h2h_match.home_is_average AS h2h_home_is_average,
		h2h_match.away_entry_id AS h2h_away_entry_id,
		away_match_entry.entry_name AS h2h_away_entry_name,
		away_match_entry.player_name AS h2h_away_player_name,
		h2h_match.away_points AS h2h_away_points,
		h2h_match.away_is_average AS h2h_away_is_average,
		h2h_match.is_bye AS h2h_is_bye,
		h2h_match.source_checked_at AS h2h_source_checked_at,
		reference_event.event_id AS h2h_reference_event_id,
		reference_event.is_current AS h2h_event_is_current,
		reference_event.finished AS h2h_event_finished,
		reference_event.data_checked AS h2h_event_data_checked
	FROM competition.entries e
	LEFT JOIN competition.entry_leagues l
		ON l.season_id = e.season_id
		AND l.entry_id = e.entry_id
	LEFT JOIN LATERAL (
		SELECT t.tournament_id
		FROM competition.tournaments t
		WHERE t.season_id = l.season_id
			AND t.league_id = l.league_id
			AND t.league_type = l.league_type
		ORDER BY
			(
				l.league_type::text = 'h2h'
				AND t.roster_mode::text = 'official_sync'
				AND t.state::text IN ('active', 'finished')
				AND t.setup_status::text = 'ready'
				AND t.official_schedule_locked_at IS NOT NULL
				AND t.standings_ready_at IS NOT NULL
			) DESC,
			CASE t.state::text
				WHEN 'active' THEN 2
				WHEN 'finished' THEN 1
				ELSE 0
			END DESC,
			(t.setup_status::text = 'ready' AND t.standings_ready_at IS NOT NULL) DESC,
			t.updated_at DESC,
			t.tournament_id DESC
		LIMIT 1
	) tracked ON TRUE
	LEFT JOIN LATERAL (
		SELECT t.tournament_id
		FROM competition.tournaments t
		WHERE t.season_id = l.season_id
			AND t.league_id = l.league_id
			AND t.league_type = l.league_type
			AND t.roster_mode::text = 'official_sync'
			AND t.group_mode::text = 'battle_races'
		ORDER BY t.tournament_id DESC
		LIMIT 1
	) official_h2h ON l.league_type::text = 'h2h'
	LEFT JOIN LATERAL (
		SELECT event_id, is_current, finished, data_checked
		FROM fpl.events event
		WHERE event.season_id = e.season_id
			AND (
				event.is_current = TRUE
				OR event.is_next = TRUE
				OR (event.finished = TRUE AND event.data_checked = TRUE)
			)
		ORDER BY
			event.is_current DESC,
			event.is_next DESC,
			(event.finished AND event.data_checked) DESC,
			event.event_id DESC
		LIMIT 1
	) reference_event ON TRUE
	LEFT JOIN LATERAL (
		SELECT candidate.*
		FROM (
			SELECT
				battle.official_match_id,
				battle.event_id,
				battle.source_order,
				battle.home_entry_id,
				battle.home_net_points AS home_points,
				battle.home_is_average,
				battle.away_entry_id,
				battle.away_net_points AS away_points,
				battle.away_is_average,
				battle.is_bye,
				battle.source_checked_at
			FROM competition.tournament_battle_group_results battle
			WHERE battle.season_id = e.season_id
				AND battle.tournament_id = COALESCE(official_h2h.tournament_id, tracked.tournament_id)
				AND battle.event_id = reference_event.event_id
				AND battle.official_match_id IS NOT NULL
				AND (battle.home_entry_id = e.entry_id OR battle.away_entry_id = e.entry_id)
			UNION ALL
			SELECT
				knockout.official_match_id,
				knockout.event_id,
				knockout.source_order,
				knockout.home_entry_id,
				knockout.home_net_points AS home_points,
				FALSE AS home_is_average,
				knockout.away_entry_id,
				knockout.away_net_points AS away_points,
				FALSE AS away_is_average,
				(knockout.home_entry_id IS NULL OR knockout.away_entry_id IS NULL) AS is_bye,
				knockout.source_checked_at
			FROM competition.tournament_knockout_results knockout
			WHERE knockout.season_id = e.season_id
				AND knockout.tournament_id = COALESCE(official_h2h.tournament_id, tracked.tournament_id)
				AND knockout.event_id = reference_event.event_id
				AND knockout.official_match_id IS NOT NULL
				AND (knockout.home_entry_id = e.entry_id OR knockout.away_entry_id = e.entry_id)
		) candidate
		ORDER BY candidate.source_order ASC, candidate.official_match_id ASC
		LIMIT 1
	) h2h_match ON l.league_type::text = 'h2h'
	LEFT JOIN competition.entries home_match_entry
		ON home_match_entry.season_id = e.season_id
		AND home_match_entry.entry_id = h2h_match.home_entry_id
	LEFT JOIN competition.entries away_match_entry
		ON away_match_entry.season_id = e.season_id
		AND away_match_entry.entry_id = h2h_match.away_entry_id
	WHERE e.season_id = $1
		AND e.entry_id = $2
	ORDER BY l.league_id ASC NULLS LAST,
		l.league_type ASC NULLS LAST
`;

export const HOME_DATA_SQL_CONTRACT: readonly DataSqlContractProbe[] = [
	{
		name: "home.personal-desk",
		sql: HOME_PERSONAL_DESK_SQL,
		values: [2026, 1],
	},
];

const isoDate = (value: string | Date | null): string | null => {
	if (value === null) return null;
	const parsed = value instanceof Date ? value : new Date(value);
	return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
};

const normalizeRank = (rank: number | null): number | null =>
	rank !== null && Number.isSafeInteger(rank) && rank > 0 ? rank : null;

const integerOrNull = (value: number | null): number | null =>
	value !== null && Number.isSafeInteger(value) ? value : null;

const matchupSide = ({
	entryId,
	entryName,
	playerName,
	isAverage,
	points,
}: {
	entryId: number | null;
	entryName: string | null;
	playerName: string | null;
	isAverage: boolean | null;
	points: number | null;
}): HomeH2HMatchupSide => ({
	entryId: integerOrNull(entryId),
	entryName,
	playerName,
	isAverage: isAverage === true,
	points: integerOrNull(points),
});

const mapH2HMatchup = (row: HomePersonalDeskRow): HomeH2HMatchup | null => {
	const officialMatchId = integerOrNull(row.h2h_official_match_id);
	const eventId = integerOrNull(row.h2h_event_id);
	if (officialMatchId === null || officialMatchId <= 0 || eventId === null || eventId <= 0) {
		return null;
	}
	const home = matchupSide({
		entryId: row.h2h_home_entry_id,
		entryName: row.h2h_home_entry_name,
		playerName: row.h2h_home_player_name,
		isAverage: row.h2h_home_is_average,
		points: row.h2h_home_points,
	});
	const away = matchupSide({
		entryId: row.h2h_away_entry_id,
		entryName: row.h2h_away_entry_name,
		playerName: row.h2h_away_player_name,
		isAverage: row.h2h_away_is_average,
		points: row.h2h_away_points,
	});
	const viewerIsHome = home.entryId === row.entry_id;
	const viewerIsAway = away.entryId === row.entry_id;
	if (!viewerIsHome && !viewerIsAway) return null;
	return {
		officialMatchId,
		eventId,
		isLive: row.h2h_event_is_current === true && row.h2h_event_data_checked !== true,
		isFinal: row.h2h_event_finished === true && row.h2h_event_data_checked === true,
		isBye: row.h2h_is_bye === true,
		viewer: viewerIsHome ? home : away,
		opponent: viewerIsHome ? away : home,
		sourceCheckedAt: isoDate(row.h2h_source_checked_at),
	};
};

export const movementFromRanks = (
	currentRank: number | null,
	previousRank: number | null
): HomeRankMovement => {
	const normalizedCurrentRank = normalizeRank(currentRank);
	const normalizedPreviousRank = normalizeRank(previousRank);
	if (normalizedCurrentRank === null || normalizedPreviousRank === null) {
		return { direction: "UNKNOWN", places: null };
	}
	if (normalizedCurrentRank < normalizedPreviousRank) {
		return {
			direction: "UP",
			places: normalizedPreviousRank - normalizedCurrentRank,
		};
	}
	if (normalizedCurrentRank > normalizedPreviousRank) {
		return {
			direction: "DOWN",
			places: normalizedCurrentRank - normalizedPreviousRank,
		};
	}
	return { direction: "FLAT", places: 0 };
};

type HomeLeagueRankRow = HomeLeagueRank & {
	scoring: "classic" | "h2h";
	officialKind: ReturnType<typeof mapFplOfficialKind>;
	shortName: string | null;
};

const resolveLeagueRanks = (
	row: HomePersonalDeskRow,
	scoring: HomeLeagueRankRow["scoring"]
): { rank: number | null; previousRank: number | null } => {
	const entryRank = normalizeRank(row.entry_rank);
	const entryLastRank = normalizeRank(row.entry_last_rank);
	if (scoring === "classic") {
		return { rank: entryRank, previousRank: entryLastRank };
	}

	const startedEventValue = integerOrNull(row.league_started_event);
	const startedEvent = startedEventValue !== null && startedEventValue > 0 ? startedEventValue : 1;
	const referenceEventValue = integerOrNull(row.h2h_reference_event_id);
	const referenceEvent =
		referenceEventValue !== null && referenceEventValue > 0 ? referenceEventValue : null;
	const hasSettledOfficialRank =
		referenceEvent !== null &&
		(referenceEvent > startedEvent ||
			(referenceEvent === startedEvent &&
				row.h2h_event_finished === true &&
				row.h2h_event_data_checked === true));
	return {
		rank: hasSettledOfficialRank ? entryRank : null,
		previousRank: hasSettledOfficialRank ? entryLastRank : null,
	};
};

const mapLeagueRank = (row: HomePersonalDeskRow): HomeLeagueRankRow | null => {
	if (
		row.league_id === null ||
		row.league_type === null ||
		row.league_name === null ||
		row.league_name.trim().length === 0
	) {
		return null;
	}
	const scoring = row.league_type === "h2h" ? "h2h" : "classic";
	const { rank, previousRank } = resolveLeagueRanks(row, scoring);
	const officialKind = mapFplOfficialKind(row.official_kind);
	return {
		key: `${row.league_type}:${row.league_id}`,
		name: row.league_name,
		leagueType: scoring === "h2h" ? "H2H" : "CLASSIC",
		visibility: officialKind === OfficialLeagueKind.SYSTEM ? "PUBLIC" : "PRIVATE",
		rank,
		rankState: rank === null ? "UNAVAILABLE" : "READY",
		rankCheckedAt: isoDate(row.league_source_checked_at),
		movement: movementFromRanks(rank, previousRank),
		tournamentId: row.tournament_id,
		h2hMatchup: scoring === "h2h" ? mapH2HMatchup(row) : null,
		scoring,
		officialKind,
		shortName: row.short_name,
	};
};

const toHomeLeagueRank = (row: HomeLeagueRankRow): HomeLeagueRank => ({
	key: row.key,
	name: row.name,
	leagueType: row.leagueType,
	visibility: row.visibility,
	rank: row.rank,
	rankState: row.rankState,
	rankCheckedAt: row.rankCheckedAt,
	movement: row.movement,
	tournamentId: row.tournamentId,
	h2hMatchup: row.h2hMatchup,
});

export const homeRepository = {
	async getPersonalDesk(context: GraphQLContext, entryId: number): Promise<HomePersonalDesk> {
		const startedAt = performance.now();
		const sqlStartedAt = performance.now();
		const result = await context.database.query<HomePersonalDeskRow>(HOME_PERSONAL_DESK_SQL, [
			context.currentSeason.seasonId,
			entryId,
		]);
		const sqlDurationMs = performance.now() - sqlStartedAt;
		const first = result.rows[0];
		if (!first) {
			context.logger.info(
				{
					requestId: context.requestId,
					operationName: context.operationName,
					sqlDurationMs: Number(sqlDurationMs.toFixed(2)),
					leagueRowCount: 0,
					h2hMatchupCount: 0,
					totalDurationMs: Number((performance.now() - startedAt).toFixed(2)),
				},
				"Home personal desk unavailable"
			);
			return {
				entryId,
				state: "UNAVAILABLE",
				entryName: null,
				playerName: null,
				region: null,
				overallPoints: null,
				pointsState: "UNAVAILABLE",
				pointsCheckedAt: null,
				overallRank: null,
				rankState: "UNAVAILABLE",
				rankCheckedAt: null,
				teamValue: null,
				bank: null,
				leagueRanks: [],
				sourceCheckedAt: null,
			};
		}

		const mappingStartedAt = performance.now();
		const sourceCheckedAt = isoDate(first.source_checked_at);
		const sourceAgeMs = sourceCheckedAt
			? Math.max(0, Date.now() - Date.parse(sourceCheckedAt))
			: null;
		const mappedLeagues = result.rows
			.map(mapLeagueRank)
			.filter((rank): rank is HomeLeagueRankRow => rank !== null);
		const leagueRanks = selectHomeLeagues(mappedLeagues).map(toHomeLeagueRank);
		const h2hMatchupCount = leagueRanks.filter((league) => league.h2hMatchup !== null).length;
		const state: HomePersonalDeskState =
			sourceAgeMs === null || sourceAgeMs > HOME_PERSONAL_STALE_AFTER_MS
				? "STALE"
				: mappedLeagues.length === 0
					? "EMPTY"
					: "READY";
		const mapped = {
			entryId,
			state,
			entryName: first.entry_name,
			playerName: first.player_name,
			region: first.region,
			overallPoints: first.overall_points,
			pointsState: "UNAVAILABLE",
			pointsCheckedAt: null,
			overallRank: first.overall_rank,
			rankState: normalizeRank(first.overall_rank) === null ? "UNAVAILABLE" : "READY",
			rankCheckedAt: sourceCheckedAt,
			teamValue: first.team_value,
			bank: first.bank,
			leagueRanks,
			sourceCheckedAt,
		} satisfies HomePersonalDesk;
		const mappingDurationMs = performance.now() - mappingStartedAt;

		context.logger.info(
			{
				requestId: context.requestId,
				operationName: context.operationName,
				sqlDurationMs: Number(sqlDurationMs.toFixed(2)),
				mappingDurationMs: Number(mappingDurationMs.toFixed(2)),
				leagueRowCount: leagueRanks.length,
				h2hMatchupCount,
				sourceAgeMs,
				state,
				totalDurationMs: Number((performance.now() - startedAt).toFixed(2)),
			},
			"Home personal desk loaded"
		);
		return mapped;
	},
};
