import type { GraphQLContext } from "../../graphql/context";

export type HomeRankDirection = "UP" | "DOWN" | "FLAT" | "UNKNOWN";
export type HomePersonalDeskState = "READY" | "EMPTY" | "STALE" | "UNAVAILABLE";

export type HomeRankMovement = {
	direction: HomeRankDirection;
	places: number | null;
};

export type HomeLeagueRank = {
	key: string;
	name: string;
	rank: number | null;
	movement: HomeRankMovement;
	tournamentId: number | null;
};

export type HomePersonalDesk = {
	state: HomePersonalDeskState;
	entryName: string | null;
	playerName: string | null;
	overallPoints: number | null;
	overallRank: number | null;
	teamValue: number | null;
	leagueRanks: HomeLeagueRank[];
	sourceCheckedAt: string | null;
};

type HomePersonalDeskRow = {
	entry_name: string | null;
	player_name: string | null;
	overall_points: number | null;
	overall_rank: number | null;
	team_value: number | null;
	source_checked_at: string | Date | null;
	league_id: number | null;
	league_type: string | null;
	league_name: string | null;
	entry_rank: number | null;
	entry_last_rank: number | null;
	tournament_id: number | null;
};

const HOME_PERSONAL_STALE_AFTER_MS = 30 * 60 * 60 * 1000;

export const HOME_PERSONAL_DESK_SQL = `
	SELECT
		e.entry_name,
		e.player_name,
		e.overall_points,
		e.overall_rank,
		e.team_value,
		e.updated_at AS source_checked_at,
		l.league_id,
		l.league_type::text AS league_type,
		l.league_name,
		l.entry_rank,
		l.entry_last_rank,
		tracked.tournament_id
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
		ORDER BY t.tournament_id
		LIMIT 1
	) tracked ON TRUE
	WHERE e.season_id = $1
		AND e.entry_id = $2
	ORDER BY l.entry_rank ASC NULLS LAST,
		l.league_name ASC NULLS LAST,
		l.league_type ASC NULLS LAST,
		l.league_id ASC NULLS LAST
`;

const isoDate = (value: string | Date | null): string | null => {
	if (value === null) return null;
	const parsed = value instanceof Date ? value : new Date(value);
	return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
};

export const movementFromRanks = (
	currentRank: number | null,
	previousRank: number | null
): HomeRankMovement => {
	if (currentRank === null || previousRank === null) {
		return { direction: "UNKNOWN", places: null };
	}
	if (currentRank < previousRank) {
		return { direction: "UP", places: previousRank - currentRank };
	}
	if (currentRank > previousRank) {
		return { direction: "DOWN", places: currentRank - previousRank };
	}
	return { direction: "FLAT", places: 0 };
};

const mapLeagueRank = (row: HomePersonalDeskRow): HomeLeagueRank | null => {
	if (
		row.league_id === null ||
		row.league_type === null ||
		row.league_name === null ||
		row.league_name.trim().length === 0
	) {
		return null;
	}
	return {
		key: `${row.league_type}:${row.league_id}`,
		name: row.league_name,
		rank: row.entry_rank,
		movement: movementFromRanks(row.entry_rank, row.entry_last_rank),
		tournamentId: row.tournament_id,
	};
};

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
					totalDurationMs: Number((performance.now() - startedAt).toFixed(2)),
				},
				"Home personal desk unavailable"
			);
			return {
				state: "UNAVAILABLE",
				entryName: null,
				playerName: null,
				overallPoints: null,
				overallRank: null,
				teamValue: null,
				leagueRanks: [],
				sourceCheckedAt: null,
			};
		}

		const mappingStartedAt = performance.now();
		const sourceCheckedAt = isoDate(first.source_checked_at);
		const sourceAgeMs = sourceCheckedAt
			? Math.max(0, Date.now() - Date.parse(sourceCheckedAt))
			: null;
		const leagueRanks = result.rows
			.map(mapLeagueRank)
			.filter((rank): rank is HomeLeagueRank => rank !== null);
		const state: HomePersonalDeskState =
			sourceAgeMs === null || sourceAgeMs > HOME_PERSONAL_STALE_AFTER_MS
				? "STALE"
				: leagueRanks.length === 0
					? "EMPTY"
					: "READY";
		const mapped = {
			state,
			entryName: first.entry_name,
			playerName: first.player_name,
			overallPoints: first.overall_points,
			overallRank: first.overall_rank,
			teamValue: first.team_value,
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
				sourceAgeMs,
				state,
				totalDurationMs: Number((performance.now() - startedAt).toFixed(2)),
			},
			"Home personal desk loaded"
		);
		return mapped;
	},
};
