import { Pool } from "pg";
import {
	assessAvailability,
	assessOutput,
	assessRole,
	averagePercentiles,
	buildOwnBaseline,
	composePlayerState,
	percentile,
} from "../src/domains/player-state/engine";
import type {
	PlayerGameweekSample,
	PlayerStateBaselineSeason,
	PlayerStateTrend,
} from "../src/domains/player-state/types";

type LiveRow = {
	season: string;
	event_id: number;
	event_cutoff_at: Date | string | null;
	element_id: number;
	player_code: number;
	position: number;
	total_points: number;
	minutes: number | null;
	started: boolean | null;
	bonus: number | null;
	availability_status: string | null;
	chance_of_playing_this_round: number | null;
	availability_captured_at: Date | string | null;
	availability_known: boolean;
};

type MetricRow = {
	elementId: number;
	playerCode: number;
	position: number;
	minutes: number;
	pointsPer90: number | null;
	returnRate: number;
	bonusPer90: number | null;
};

type Observation = {
	season: string;
	eventId: number;
	trend: PlayerStateTrend;
	futureFivePoints: number;
};

const MARKET_STALE_AFTER_MS = 36 * 60 * 60 * 1000;

const ageAtCutoff = (cutoff: Date | string | null, capturedAt: Date | string | null): number => {
	if (cutoff === null || capturedAt === null) return Number.POSITIVE_INFINITY;
	const cutoffMs = cutoff instanceof Date ? cutoff.getTime() : Date.parse(cutoff);
	const capturedMs = capturedAt instanceof Date ? capturedAt.getTime() : Date.parse(capturedAt);
	if (!Number.isFinite(cutoffMs) || !Number.isFinite(capturedMs)) return Number.POSITIVE_INFINITY;
	return Math.max(cutoffMs - capturedMs, 0);
};

const sql = `
	SELECT
		live.season,
		live.event_id,
		COALESCE(event.deadline_time, event.created_at) AS event_cutoff_at,
		live.element_id,
		player.code AS player_code,
		player.type AS position,
		live.total_points,
		live.minutes,
		live.starts AS started,
		live.bonus,
		market.status AS availability_status,
		market.chance_of_playing_this_round,
		market.captured_at AS availability_captured_at,
		market.element_id IS NOT NULL AS availability_known
	FROM fpl_event_live_history live
	JOIN fpl_season_archives archive
		ON archive.season = live.season AND archive.status = 'sealed'
	JOIN fpl_event_history event
		ON event.season = live.season AND event.id = live.event_id
	JOIN fpl_player_history player
		ON player.season = live.season AND player.id = live.element_id
	LEFT JOIN LATERAL (
		SELECT
			market.element_id,
			market.status,
			market.chance_of_playing_this_round
		FROM fpl_player_market_snapshot_history market
		WHERE market.season = live.season
			AND market.element_id = live.element_id
			AND market.snapshot_date <= COALESCE(event.deadline_time, event.created_at)::date
			AND market.captured_at <= COALESCE(event.deadline_time, event.created_at)
		ORDER BY market.snapshot_date DESC, market.captured_at DESC
		LIMIT 1
	) market ON true
	ORDER BY live.season, live.event_id, live.element_id
`;

const round = (value: number, places = 2): number => {
	const scale = 10 ** places;
	return Math.round(value * scale) / scale;
};

const key = (elementId: number, eventId: number): string => `${elementId}:${eventId}`;

function metricsForWindow(input: {
	players: Array<{ elementId: number; playerCode: number; position: number }>;
	byPlayerEvent: Map<string, LiveRow>;
	eventIds: number[];
}): MetricRow[] {
	return input.players.map((player) => {
		const rows = input.eventIds.map(
			(eventId) => input.byPlayerEvent.get(key(player.elementId, eventId)) ?? null
		);
		const minutes = rows.reduce((sum, row) => sum + (row?.minutes ?? 0), 0);
		const points = rows.reduce((sum, row) => sum + (row?.total_points ?? 0), 0);
		const bonus = rows.reduce((sum, row) => sum + (row?.bonus ?? 0), 0);
		return {
			...player,
			minutes,
			pointsPer90: minutes > 0 ? (points * 90) / minutes : null,
			returnRate:
				input.eventIds.length === 0
					? 0
					: (rows.filter((row) => (row?.total_points ?? 0) >= 5).length / input.eventIds.length) *
						100,
			bonusPer90: minutes > 0 ? (bonus * 90) / minutes : null,
		};
	});
}

function compositePercentiles(
	rows: MetricRow[],
	population: MetricRow[] = rows
): Map<number, number | null> {
	const result = new Map<number, number | null>();
	for (const position of [1, 2, 3, 4]) {
		const peers = population.filter((row) => row.position === position);
		for (const row of rows.filter((candidate) => candidate.position === position)) {
			result.set(
				row.elementId,
				averagePercentiles([
					percentile(
						row.pointsPer90,
						peers.map((peer) => peer.pointsPer90)
					),
					percentile(
						row.returnRate,
						peers.map((peer) => peer.returnRate)
					),
					percentile(
						row.bonusPer90,
						peers.map((peer) => peer.bonusPer90)
					),
				])
			);
		}
	}
	return result;
}

function samplesFor(
	elementId: number,
	eventIds: number[],
	byPlayerEvent: Map<string, LiveRow>
): PlayerGameweekSample[] {
	return eventIds.map((eventId) => {
		const row = byPlayerEvent.get(key(elementId, eventId));
		return {
			eventId,
			totalPoints: row?.total_points ?? 0,
			minutes: row?.minutes ?? 0,
			started: Boolean(row?.started),
			bonus: row?.bonus ?? 0,
			covered: true,
		};
	});
}

function futurePoints(
	elementId: number,
	eventIds: number[],
	byPlayerEvent: Map<string, LiveRow>
): number {
	return eventIds.reduce(
		(sum, eventId) => sum + (byPlayerEvent.get(key(elementId, eventId))?.total_points ?? 0),
		0
	);
}

async function main(): Promise<void> {
	if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
	const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
	const storage = await pool.query<{
		player_history: string | null;
		event_live_history: string | null;
		market_snapshot_history: string | null;
	}>(`
		SELECT
			to_regclass('public.fpl_player_history')::text AS player_history,
			to_regclass('public.fpl_event_live_history')::text AS event_live_history,
			to_regclass('public.fpl_player_market_snapshot_history')::text AS market_snapshot_history
	`);
	const storageRow = storage.rows[0];
	if (
		!storageRow?.player_history ||
		!storageRow.event_live_history ||
		!storageRow.market_snapshot_history
	) {
		await pool.end();
		console.log(
			JSON.stringify(
				{
					engineVersion: "player-state-v1.1",
					mode: "fpl-only",
					method: "sealed-season walk-forward; features through GW N; target GW N+1..N+5",
					seasons: [],
					observations: 0,
					releaseGate: "WITHHOLD",
					reason: "FPL_HISTORY_STORAGE_UNAVAILABLE",
				},
				null,
				2
			)
		);
		process.exitCode = 1;
		return;
	}
	const result = await pool.query<LiveRow>(sql);
	await pool.end();

	const seasons = [...new Set(result.rows.map((row) => row.season))].sort();
	const historyByCode = new Map<number, PlayerStateBaselineSeason[]>();
	const observations: Observation[] = [];

	for (const season of seasons) {
		const rows = result.rows.filter((row) => row.season === season);
		const eventIds = [...new Set(rows.map((row) => row.event_id))].sort((a, b) => a - b);
		const byPlayerEvent = new Map(rows.map((row) => [key(row.element_id, row.event_id), row]));
		const playerMap = new Map(
			rows.map((row) => [
				row.element_id,
				{
					elementId: row.element_id,
					playerCode: row.player_code,
					position: row.position,
				},
			])
		);
		const players = [...playerMap.values()];

		for (let eventIndex = 2; eventIndex <= eventIds.length - 6; eventIndex += 1) {
			const eventId = eventIds[eventIndex];
			if (eventId === undefined) continue;
			const seasonToDateIds = eventIds.slice(0, eventIndex + 1);
			const recentIds = seasonToDateIds.slice(-5);
			const previousIds = seasonToDateIds.slice(-10, -5);
			const targetIds = eventIds.slice(eventIndex + 1, eventIndex + 6);
			const seasonMetrics = metricsForWindow({
				players,
				byPlayerEvent,
				eventIds: seasonToDateIds,
			});
			// playerStateProfile only compares players with the production
			// season-to-date minutes gate. Keep both the percentile cohort and
			// sealed observations on that same gate.
			const eligibleIds = new Set(
				seasonMetrics.filter((row) => row.minutes >= 900).map((row) => row.elementId)
			);
			const eligiblePlayers = players.filter(
				(player) =>
					eligibleIds.has(player.elementId) && byPlayerEvent.has(key(player.elementId, eventId))
			);
			const cohortIds = new Set(eligiblePlayers.map((player) => player.elementId));
			const cohortMetrics = seasonMetrics.filter((row) => cohortIds.has(row.elementId));
			const recentMetrics = metricsForWindow({
				players: eligiblePlayers,
				byPlayerEvent,
				eventIds: recentIds,
			});
			const seasonPercentiles = compositePercentiles(cohortMetrics);
			const recentPercentiles = compositePercentiles(recentMetrics);

			for (const player of eligiblePlayers) {
				const currentPercentile = seasonPercentiles.get(player.elementId) ?? null;
				const recentPercentile = recentPercentiles.get(player.elementId) ?? null;
				if (currentPercentile === null || recentPercentile === null) continue;
				const currentRow = byPlayerEvent.get(key(player.elementId, eventId));
				if (!currentRow?.availability_known) continue;
				const availability = assessAvailability({
					status: currentRow.availability_status,
					chanceOfPlayingThisRound: currentRow.chance_of_playing_this_round,
					stale:
						ageAtCutoff(currentRow.event_cutoff_at, currentRow.availability_captured_at) >
						MARKET_STALE_AFTER_MS,
				});
				if (availability.unavailable) continue;
				const ownBaseline = buildOwnBaseline(historyByCode.get(player.playerCode) ?? []);
				const output = assessOutput({
					currentPercentile,
					recentPercentile,
					seasonBaselinePercentile: currentPercentile,
					ownBaselinePercentile: ownBaseline.weightedPercentile,
				});
				const role = assessRole(
					samplesFor(player.elementId, [...recentIds].reverse(), byPlayerEvent),
					samplesFor(player.elementId, [...previousIds].reverse(), byPlayerEvent)
				);
				const state = composePlayerState({
					availability,
					role,
					output,
					process: {
						rating: "UNAVAILABLE",
						direction: "UNKNOWN",
						available: false,
						sampleMinutes: 0,
						smallSample: false,
						reasonCodes: ["PROCESS_UNAVAILABLE_UNDERSTAT"],
						metrics: [],
					},
					fplSufficient: true,
					completeFplWindow: recentIds.length === 5,
					historySeasonCount: ownBaseline.seasons.length,
				});
				observations.push({
					season,
					eventId,
					trend: state.trend,
					futureFivePoints: futurePoints(player.elementId, targetIds, byPlayerEvent),
				});
			}
		}

		const finalMetrics = metricsForWindow({ players, byPlayerEvent, eventIds });
		const finalPercentiles = compositePercentiles(
			finalMetrics,
			finalMetrics.filter((row) => row.minutes >= 900)
		);
		for (const row of finalMetrics) {
			if (row.minutes < 450) continue;
			const positionPercentile = finalPercentiles.get(row.elementId) ?? null;
			if (positionPercentile === null) continue;
			const existing = historyByCode.get(row.playerCode) ?? [];
			existing.push({
				season,
				position: row.position,
				minutes: row.minutes,
				pointsPer90: row.pointsPer90,
				returnRate: row.returnRate,
				bonusPer90: row.bonusPer90,
				positionPercentile,
				weight: 0,
				expectedMetricsAvailable: season >= "2223",
				understatProcessPercentile: null,
			});
			historyByCode.set(row.playerCode, existing);
		}
	}

	const orderedTrends = ["RISING", "STABLE", "FALLING"] as const;
	const summary = Object.fromEntries(
		orderedTrends.map((trend) => {
			const values = observations
				.filter((observation) => observation.trend === trend)
				.map((observation) => observation.futureFivePoints);
			const sorted = [...values].sort((left, right) => left - right);
			return [
				trend,
				{
					count: values.length,
					mean:
						values.length === 0
							? null
							: round(values.reduce((sum, value) => sum + value, 0) / values.length),
					median: sorted.length === 0 ? null : sorted[Math.floor(sorted.length / 2)],
				},
			];
		})
	) as Record<
		(typeof orderedTrends)[number],
		{ count: number; mean: number | null; median: number | null }
	>;
	const risingMean = summary.RISING.mean;
	const stableMean = summary.STABLE.mean;
	const fallingMean = summary.FALLING.mean;
	const passed =
		orderedTrends.every((trend) => summary[trend].count >= 100) &&
		risingMean !== null &&
		stableMean !== null &&
		fallingMean !== null &&
		risingMean > stableMean &&
		stableMean > fallingMean &&
		risingMean - fallingMean >= 0.5;

	console.log(
		JSON.stringify(
			{
				engineVersion: "player-state-v1.1",
				mode: "fpl-only",
				method: "sealed-season walk-forward; features through GW N; target GW N+1..N+5",
				seasons,
				observations: observations.length,
				summary,
				releaseGate: passed ? "PASS" : "WITHHOLD",
			},
			null,
			2
		)
	);
	if (!passed) process.exitCode = 1;
}

await main();
