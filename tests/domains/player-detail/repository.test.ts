import { describe, expect, it } from "bun:test";
import { playerDetailRepository } from "../../../src/domains/player-detail/repository";
import { gqlCacheKey } from "../../../src/infra/cache-key";
import {
	buildCorePublication,
	buildSnapshotContext,
	buildTestCoreData,
	TestRedis,
} from "../../helpers/data-publication";

type TableRows = Record<string, unknown[]>;

const queryBuilder = (rows: unknown[], queryError: unknown = null) => {
	let selectedRows = [...rows];
	const builder = {
		select: () => builder,
		eq: (column: string, value: unknown) => {
			selectedRows = selectedRows.filter((row) => {
				const actual = (row as Record<string, unknown>)[column];
				return actual === undefined || actual === value || String(actual) === String(value);
			});
			return builder;
		},
		lte: (column: string, value: unknown) => {
			selectedRows = selectedRows.filter((row) => {
				const actual = (row as Record<string, unknown>)[column];
				return actual === undefined || Number(actual) <= Number(value);
			});
			return builder;
		},
		in: (column: string, values: unknown[]) => {
			selectedRows = selectedRows.filter((row) =>
				values.some((value) => {
					const actual = (row as Record<string, unknown>)[column];
					return actual === undefined || actual === value || String(actual) === String(value);
				})
			);
			return builder;
		},
		or: () => builder,
		order: (column: string, options?: { ascending?: boolean }) => {
			selectedRows.sort((left, right) => {
				const leftValue = (left as Record<string, unknown>)[column];
				const rightValue = (right as Record<string, unknown>)[column];
				const comparison = String(leftValue ?? "").localeCompare(String(rightValue ?? ""));
				return options?.ascending === false ? -comparison : comparison;
			});
			return builder;
		},
		limit: (count: number) => {
			selectedRows = selectedRows.slice(0, count);
			return builder;
		},
		range: (from: number, to: number) => {
			selectedRows = selectedRows.slice(from, to + 1);
			return builder;
		},
		then: <TResult1 = { data: unknown[] | null; error: unknown }, TResult2 = never>(
			onfulfilled?:
				| ((value: { data: unknown[] | null; error: unknown }) => TResult1 | PromiseLike<TResult1>)
				| null,
			onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
		) =>
			Promise.resolve({ data: queryError === null ? selectedRows : null, error: queryError }).then(
				onfulfilled,
				onrejected
			),
	};
	return builder;
};

function createContext(args: {
	currentEvent: Record<string, unknown> | null;
	tables: TableRows;
	fromCalls?: string[];
	lifecycleState?: "reference_only" | "completed" | "preseason" | "active" | "closed";
}) {
	const fromCalls = args.fromCalls ?? [];
	const explicitCurrent = Number(args.currentEvent?.id);
	const tableCurrent = (args.tables["fpl.events"] ?? []).find(
		(row) => (row as { is_current?: boolean }).is_current === true
	) as { id?: number } | undefined;
	const currentEventId =
		Number.isInteger(explicitCurrent) && explicitCurrent > 0
			? explicitCurrent
			: (tableCurrent?.id ?? null);
	const base = buildTestCoreData(currentEventId);
	let fixtures = base.fixtures;
	if ((args.tables["fpl.fixtures"]?.length ?? 0) > 1) {
		const teamFixture = fixtures.find(
			(fixture) => fixture.eventId === 4 && (fixture.teamHId === 1 || fixture.teamAId === 1)
		)!;
		const swapFixture = fixtures.find(
			(fixture) => fixture.eventId === 3 && fixture.teamHId !== 1 && fixture.teamAId !== 1
		)!;
		fixtures = fixtures.map((fixture) =>
			fixture.id === teamFixture.id
				? { ...fixture, eventId: 3 }
				: fixture.id === swapFixture.id
					? { ...fixture, eventId: 4 }
					: fixture
		);
	}
	const core = {
		...base,
		fixtures,
		players: base.players.map((player) =>
			player.id === 9
				? {
						...player,
						code: 900,
						webName: "Test Player",
						teamId: 1,
						type: 3,
						price: 75,
						startPrice: 70,
						selectedByPercent: 8.5,
					}
				: player
		),
		teams: base.teams.map((team) =>
			team.id === 1
				? { ...team, code: 1, name: "Alpha", shortName: "ALP" }
				: team.id === 2
					? { ...team, code: 2, name: "Beta", shortName: "BET" }
					: team.id === 3
						? { ...team, code: 3, name: "Gamma", shortName: "GAM" }
						: team
		),
	};
	const explicitSnapshotRows = args.tables["fpl.player_event_snapshot_bundles"] ?? [];
	const maxPublishedEvent = Math.max(
		0,
		...core.events.filter((event) => event.finished || event.isCurrent).map((event) => event.id)
	);
	const snapshotRows = Array.from({ length: maxPublishedEvent }, (_, eventIndex) =>
		core.players.map((player) => {
			const eventId = eventIndex + 1;
			const override = explicitSnapshotRows.find(
				(row) =>
					Number((row as { element_id?: unknown }).element_id) === player.id &&
					Number((row as { event_id?: unknown }).event_id) === eventId
			) as Record<string, unknown> | undefined;
			return {
				element_id: player.id,
				event_id: eventId,
				total_points: 0,
				...override,
			};
		})
	).flat();
	const publicationRows = Array.from({ length: maxPublishedEvent }, (_, eventIndex) => ({
		event_id: eventIndex + 1,
		revision: "11",
		source_checked_at: new Date().toISOString(),
		published_at: new Date().toISOString(),
		row_count: core.players.length,
		expected_row_count: core.players.length,
		baseline_verified_at: new Date().toISOString(),
	}));
	const bundleRows = snapshotRows.map((row) => {
		const publication = publicationRows.find((candidate) => candidate.event_id === row.event_id);
		return {
			...row,
			publication_revision: publication?.revision ?? "11",
			publication_source_checked_at: publication?.source_checked_at ?? new Date().toISOString(),
			publication_published_at: publication?.published_at ?? new Date().toISOString(),
			publication_row_count: publication?.row_count ?? core.players.length,
			publication_expected_row_count: publication?.expected_row_count ?? core.players.length,
			publication_content_sha256: "test-player-event-bundle",
			publication_baseline_verified_at:
				publication?.baseline_verified_at ?? new Date().toISOString(),
		};
	});
	const context = buildSnapshotContext(new TestRedis(buildCorePublication("2627", 7, core)), {
		dataRevision: "core-7",
	});
	if (args.lifecycleState) {
		context.currentSeason = { ...context.currentSeason, lifecycleState: args.lifecycleState };
	}
	context.data = {
		read: (table: string) => {
			fromCalls.push(table);
			if (table === "fpl.player_event_snapshot_bundles") return queryBuilder(bundleRows);
			if (table === "fpl.player_event_snapshot_publications") {
				return queryBuilder(args.tables[table] ?? publicationRows);
			}
			return queryBuilder(args.tables[table] ?? []);
		},
	} as never;
	return context;
}

const marketRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
	snapshot_date: "2026-08-08",
	captured_at: new Date().toISOString(),
	selected_by_percent: "12.5",
	transfers_in: 1000,
	transfers_out: 200,
	transfers_in_event: 321,
	transfers_out_event: 45,
	status: "a",
	news: "",
	news_added: null,
	chance_of_playing_this_round: 100,
	chance_of_playing_next_round: 100,
	...overrides,
});

const fixtureRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
	id: 30,
	code: 300,
	event_id: 3,
	finished: false,
	finished_provisional: false,
	kickoff_time: "2026-08-15T14:00:00.000Z",
	minutes: 0,
	started: false,
	team_h_id: 1,
	team_a_id: 2,
	team_h_score: null,
	team_a_score: null,
	team_h_difficulty: 2,
	team_a_difficulty: 4,
	...overrides,
});

describe("playerDetailRepository", () => {
	it("batch-reads two detail cache keys with one Redis MGET", async () => {
		const context = createContext({
			currentEvent: null,
			tables: {
				"fpl.events": [
					{
						id: 1,
						finished: false,
						is_current: false,
						deadline_time_epoch: Math.floor(Date.now() / 1000) + 86_400,
					},
				],
				"fpl.player_market_snapshots": [marketRow()],
			},
		});
		const redis = context.redis as unknown as TestRedis;
		let detailMgetCalls = 0;
		let detailGetCalls = 0;
		const originalMget = redis.mget;
		const originalGet = redis.get;
		redis.mget = async (...keys: string[]) => {
			if (keys.every((key) => key.includes("player-detail"))) detailMgetCalls += 1;
			return originalMget(...keys);
		};
		redis.get = async (key: string) => {
			if (key.includes("player-detail")) detailGetCalls += 1;
			return originalGet(key);
		};

		const details = await playerDetailRepository.getPlayerDetails(context, [9, 10], 1);

		expect(details.get(9)?.id).toBe(9);
		expect(details.get(10)?.id).toBe(10);
		expect(detailMgetCalls).toBe(1);
		expect(detailGetCalls).toBe(0);
	});

	it("gates season production during preseason but keeps current market and fixtures", async () => {
		const fromCalls: string[] = [];
		const context = createContext({
			currentEvent: null,
			lifecycleState: "preseason",
			fromCalls,
			tables: {
				"fpl.events": [
					{
						id: 1,
						finished: false,
						is_current: false,
						deadline_time_epoch: Math.floor(Date.now() / 1000) + 86_400,
					},
				],
				"fpl.player_market_snapshots": [marketRow()],
				"fpl.fixtures": [fixtureRow({ event_id: 1 })],
				"fpl.player_event_snapshot_bundles": [{ element_id: 9, event_id: 1, total_points: 200 }],
			},
		});

		const detail = await playerDetailRepository.getPlayerDetail(context, 9, 1);

		expect(detail?.statsContext).toEqual({
			scope: "UNAVAILABLE",
			season: "2627",
			asOfEventId: null,
			status: "PRESEASON",
			revision: null,
			sourceCheckedAt: null,
			publishedAt: null,
			rowCount: 0,
			expectedRowCount: 0,
		});
		expect(detail?.totalPoints).toBeNull();
		expect(detail?.form).toBeNull();
		expect(detail?.selectedByPercent).toBe(12.5);
		expect(detail?.transfersInEvent).toBe(321);
		expect(detail?.injuryAvailability?.status).toBe("a");
		expect(detail?.dataAvailability.isFullyAuthoritative).toBe(true);
		expect(detail?.dataAvailability.recentGameweeks.state).toBe("EMPTY");
		expect(detail?.recentGameweeks).toEqual([]);
		expect(detail?.fixtures).toHaveLength(38);
		expect(detail?.fixtures.filter((fixture) => fixture.bgw)).toHaveLength(0);
		expect(fromCalls).not.toContain("fpl.player_event_snapshot_bundles");
		expect(fromCalls).not.toContain("fpl.player_gameweek_stats");
	});

	it("marks current-GW points provisional from the core event state", async () => {
		const context = createContext({
			currentEvent: null,
			tables: {
				"fpl.events": [
					{
						id: 3,
						finished: false,
						is_current: true,
						deadline_time_epoch: Math.floor(Date.now() / 1000) - 60,
					},
				],
				"fpl.player_market_snapshots": [marketRow()],
				"fpl.player_event_snapshot_bundles": [{ element_id: 9, event_id: 3, total_points: 55 }],
				"fpl.player_gameweek_stats": [
					{
						event_id: 3,
						total_points: 9,
						minutes: 90,
						starts: true,
						goals_scored: 1,
						assists: 0,
						clean_sheets: 1,
						saves: 0,
						bonus: 2,
						bps: 31,
					},
				],
				"fpl.fixtures": [fixtureRow()],
			},
		});

		const detail = await playerDetailRepository.getPlayerDetail(context, 9, 3);

		expect(detail?.statsContext).toMatchObject({
			scope: "CURRENT_SEASON",
			season: "2627",
			asOfEventId: 3,
			status: "AVAILABLE",
			revision: "11",
			rowCount: 220,
			expectedRowCount: 220,
		});
		expect(detail?.recentGameweeks[0]?.provisional).toBe(true);
	});

	it("returns nullable season stats, latest market data, recent GWs and every DGW fixture", async () => {
		const context = createContext({
			currentEvent: { id: 3, isCurrent: true, finished: false },
			tables: {
				"fpl.player_market_snapshots": [marketRow({ status: "d", news: "Knock" })],
				"fpl.player_event_snapshot_bundles": [
					{
						element_id: 9,
						event_id: 3,
						total_points: 55,
						selected_by_percent: "9.1",
						form: "5.5",
						transfers_in: 900,
						transfers_out: 100,
						transfers_in_event: 1,
						transfers_out_event: 2,
						minutes: 250,
						starts: 3,
						goals_scored: 2,
						assists: 1,
						clean_sheets: 1,
						goals_conceded: 2,
						own_goals: 0,
						penalties_saved: 0,
						yellow_cards: 0,
						red_cards: 0,
						saves: 0,
						bonus: 4,
						bps: 70,
						expected_goals: "1.4",
						expected_assists: "0.8",
						expected_goal_involvements: "2.2",
						expected_goals_conceded: "2.9",
						influence: "90",
						creativity: "80",
						threat: "100",
						ict_index: "27",
					},
				],
				"fpl.player_gameweek_stats": [
					{
						event_id: 3,
						total_points: 9,
						minutes: 90,
						starts: true,
						goals_scored: 1,
						assists: 0,
						clean_sheets: 1,
						saves: 0,
						bonus: 2,
						bps: 31,
					},
					{
						event_id: 2,
						total_points: 2,
						minutes: 45,
						starts: false,
						goals_scored: 0,
						assists: 0,
						clean_sheets: 0,
						saves: 0,
						bonus: 0,
						bps: 5,
					},
				],
				"fpl.fixtures": [
					fixtureRow({ id: 30, team_a_id: 2 }),
					fixtureRow({
						id: 31,
						code: 301,
						team_a_id: 3,
						kickoff_time: "2026-08-19T18:00:00.000Z",
					}),
				],
			},
		});

		const detail = await playerDetailRepository.getPlayerDetail(context, 9, 3);

		expect(detail?.statsContext).toMatchObject({
			scope: "CURRENT_SEASON",
			season: "2627",
			asOfEventId: 3,
			status: "AVAILABLE",
			revision: "11",
			rowCount: 220,
			expectedRowCount: 220,
		});
		expect(detail).toMatchObject({
			totalPoints: 55,
			form: 5.5,
			starts: 3,
			expectedGoals: 1.4,
			expectedAssists: 0.8,
			expectedGoalInvolvements: 2.2,
			transfersInEvent: 321,
			transfersOutEvent: 45,
			eventPoints: 9,
		});
		expect(detail?.recentGameweeks[0]).toMatchObject({
			eventId: 3,
			provisional: true,
			totalPoints: 9,
		});
		expect(detail?.recentGameweeks[0].opponents).toHaveLength(2);
		expect(detail?.fixtures.filter((fixture) => fixture.event === 3)).toHaveLength(2);
	});

	it("does not write a shared cache entry when a data section is unavailable", async () => {
		const context = createContext({
			currentEvent: { id: 3, isCurrent: true, finished: false },
			tables: {
				"fpl.player_market_snapshots": [marketRow({ selected_by_percent: "not-a-number" })],
				"fpl.player_event_snapshot_bundles": [{ element_id: 9, event_id: 3, total_points: 55 }],
				"fpl.player_gameweek_stats": [
					{
						event_id: 3,
						total_points: 9,
						minutes: 90,
						starts: true,
						goals_scored: 0,
						assists: 0,
						clean_sheets: 0,
						saves: 0,
						bonus: 0,
						bps: 10,
					},
				],
				"fpl.fixtures": [fixtureRow()],
			},
		});

		const detail = await playerDetailRepository.getPlayerDetail(context, 9, 3);
		const redis = context.redis as unknown as TestRedis;

		expect(detail?.dataAvailability.market.state).toBe("UNAVAILABLE");
		expect(detail?.dataAvailability.isFullyAuthoritative).toBe(false);
		expect(redis.setCalls.some(([key]) => key.includes("player-detail"))).toBe(false);
	});

	it("marks season-stat read failures unavailable and never caches the partial detail", async () => {
		const context = createContext({
			currentEvent: { id: 3, isCurrent: true, finished: false },
			tables: {
				"fpl.player_market_snapshots": [marketRow()],
				"fpl.player_event_snapshot_bundles": [{ element_id: 9, event_id: 3, total_points: 55 }],
				"fpl.player_gameweek_stats": [
					{
						event_id: 3,
						total_points: 9,
						minutes: 90,
						starts: true,
						goals_scored: 1,
						assists: 0,
						clean_sheets: 0,
						saves: 0,
						bonus: 0,
						bps: 10,
					},
				],
				"fpl.fixtures": [fixtureRow()],
			},
		});
		const originalRead = context.data.read.bind(context.data);
		let bundleReads = 0;
		context.data = {
			read: (table: Parameters<typeof originalRead>[0]) => {
				if (table === "fpl.player_event_snapshot_bundles") {
					bundleReads += 1;
					if (bundleReads === 2) {
						return queryBuilder([], { message: "database unavailable" });
					}
				}
				return originalRead(table);
			},
		} as never;

		const detail = await playerDetailRepository.getPlayerDetail(context, 9, 3);
		const redis = context.redis as unknown as TestRedis;

		expect(bundleReads).toBe(2);
		expect(detail?.totalPoints).toBeNull();
		expect(detail?.dataAvailability.recentGameweeks).toMatchObject({
			state: "FALLBACK",
			reasonCode: "historical_team_partial",
		});
		expect(detail?.dataAvailability.seasonStats).toMatchObject({
			state: "UNAVAILABLE",
			reasonCode: "season_stats_read_failed",
			revision: "11",
		});
		expect(detail?.dataAvailability.isFullyAuthoritative).toBe(false);
		expect(redis.setCalls.some(([key]) => key.includes("player-detail"))).toBe(false);
	});

	it("fails closed when a pinned complete stats revision no longer returns the known player", async () => {
		const context = createContext({
			currentEvent: { id: 3, isCurrent: true, finished: false },
			tables: {
				"fpl.player_market_snapshots": [marketRow()],
				"fpl.player_event_snapshot_bundles": [{ element_id: 9, event_id: 3, total_points: 55 }],
				"fpl.player_gameweek_stats": [
					{
						event_id: 3,
						total_points: 9,
						minutes: 90,
						starts: true,
						goals_scored: 1,
						assists: 0,
						clean_sheets: 0,
						saves: 0,
						bonus: 0,
						bps: 10,
					},
				],
				"fpl.fixtures": [fixtureRow()],
			},
		});
		const originalRead = context.data.read.bind(context.data);
		let bundleReads = 0;
		context.data = {
			read: (table: Parameters<typeof originalRead>[0]) => {
				if (table === "fpl.player_event_snapshot_bundles") {
					bundleReads += 1;
					if (bundleReads === 2) return queryBuilder([]);
				}
				return originalRead(table);
			},
		} as never;

		const detail = await playerDetailRepository.getPlayerDetail(context, 9, 3);
		const redis = context.redis as unknown as TestRedis;

		expect(bundleReads).toBe(2);
		expect(detail?.totalPoints).toBeNull();
		expect(detail?.dataAvailability.seasonStats).toMatchObject({
			state: "UNAVAILABLE",
			reasonCode: "season_stats_read_failed",
			revision: "11",
		});
		expect(detail?.dataAvailability.isFullyAuthoritative).toBe(false);
		expect(redis.setCalls.some(([key]) => key.includes("players:season-stats"))).toBe(false);
		expect(redis.setCalls.some(([key]) => key.includes("player-detail"))).toBe(false);
	});

	it("does not treat an unavailable stats scope as authoritative preseason emptiness", async () => {
		const context = createContext({
			currentEvent: null,
			tables: {
				"fpl.events": [
					{
						id: 1,
						finished: false,
						is_current: false,
						deadline_time_epoch: Math.floor(Date.now() / 1000) + 86_400,
					},
				],
				"fpl.player_market_snapshots": [marketRow()],
			},
		});

		const detail = await playerDetailRepository.getPlayerDetail(context, 9, 1);
		const redis = context.redis as unknown as TestRedis;

		expect(detail?.statsContext.status).toBe("UNAVAILABLE");
		expect(detail?.dataAvailability.recentGameweeks).toMatchObject({
			state: "UNAVAILABLE",
			reasonCode: "recent_stats_unavailable",
		});
		expect(detail?.dataAvailability.isFullyAuthoritative).toBe(false);
		expect(redis.setCalls.some(([key]) => key.includes("player-detail"))).toBe(false);
	});

	it("evicts a pre-hard-cut non-authoritative shared cache value", async () => {
		const degradedContext = createContext({
			currentEvent: { id: 3, isCurrent: true, finished: false },
			tables: {
				"fpl.player_market_snapshots": [marketRow({ selected_by_percent: "bad" })],
				"fpl.player_event_snapshot_bundles": [{ element_id: 9, event_id: 3 }],
				"fpl.fixtures": [fixtureRow()],
			},
		});
		const degraded = await playerDetailRepository.getPlayerDetail(degradedContext, 9, 3);
		if (!degraded) throw new Error("expected degraded player detail");
		expect(degraded.dataAvailability.isFullyAuthoritative).toBe(false);

		const context = createContext({
			currentEvent: { id: 3, isCurrent: true, finished: false },
			tables: {
				"fpl.player_market_snapshots": [marketRow()],
				"fpl.player_event_snapshot_bundles": [{ element_id: 9, event_id: 3 }],
				"fpl.fixtures": [fixtureRow()],
			},
		});
		const redis = context.redis as unknown as TestRedis;
		const key = gqlCacheKey(context, "player-detail:9:3");
		redis.values.set(key, JSON.stringify(degraded));
		let deleteCount = 0;
		const originalDelete = redis.del;
		redis.del = async (...keys: string[]) => {
			deleteCount += 1;
			return originalDelete(...keys);
		};

		const detail = await playerDetailRepository.getPlayerDetail(context, 9, 3);

		expect(deleteCount).toBe(1);
		expect(detail?.dataAvailability.market.state).toBe("READY");
		expect(detail?.dataAvailability.isFullyAuthoritative).toBe(true);
	});

	it("revalidates player-stat authority before returning a shared detail cache hit", async () => {
		const context = createContext({
			currentEvent: { id: 3, isCurrent: true, finished: false },
			tables: {
				"fpl.player_market_snapshots": [marketRow()],
				"fpl.player_event_snapshot_bundles": [{ element_id: 9, event_id: 3 }],
				"fpl.fixtures": [fixtureRow()],
			},
		});
		const authoritative = await playerDetailRepository.getPlayerDetail(context, 9, 3);
		if (!authoritative) throw new Error("expected authoritative player detail");

		const nextContext = createContext({
			currentEvent: { id: 3, isCurrent: true, finished: false },
			tables: {
				"fpl.player_market_snapshots": [marketRow()],
				"fpl.player_event_snapshot_bundles": [{ element_id: 9, event_id: 3 }],
				"fpl.fixtures": [fixtureRow()],
			},
		});
		const redis = nextContext.redis as unknown as TestRedis;
		const key = gqlCacheKey(nextContext, "player-detail:9:3");
		redis.values.set(
			key,
			JSON.stringify({
				...authoritative,
				webName: "Stale cached name",
				statsContext: {
					...authoritative.statsContext,
					sourceCheckedAt: "2026-01-01T00:00:00.000Z",
				},
			})
		);
		let deleteCount = 0;
		const originalDelete = redis.del;
		redis.del = async (...keys: string[]) => {
			deleteCount += 1;
			return originalDelete(...keys);
		};

		const detail = await playerDetailRepository.getPlayerDetail(nextContext, 9, 3);

		expect(deleteCount).toBe(1);
		expect(detail?.webName).toBe("Test Player");
		expect(detail?.statsContext.sourceCheckedAt).not.toBe("2026-01-01T00:00:00.000Z");
	});

	it("keeps event-scoped transfer counts for a past event", async () => {
		const context = createContext({
			currentEvent: { id: 5, isCurrent: true, finished: false },
			tables: {
				"fpl.events": [
					{
						id: 3,
						finished: true,
						is_current: false,
						deadline_time_epoch: Math.floor(Date.now() / 1000) - 86_400,
					},
				],
				"fpl.player_market_snapshots": [marketRow()],
				"fpl.player_event_snapshot_bundles": [
					{
						element_id: 9,
						event_id: 3,
						total_points: 55,
						transfers_in_event: 1,
						transfers_out_event: 2,
					},
				],
				"fpl.player_gameweek_stats": [
					{
						event_id: 3,
						total_points: 9,
						minutes: 90,
						starts: true,
						goals_scored: 1,
						assists: 0,
						clean_sheets: 1,
						saves: 0,
						bonus: 2,
						bps: 31,
					},
				],
				"fpl.player_fixture_stats": [{ team_id: 2, event_id: 2, fixture_id: 20 }],
				"fpl.fixtures": [fixtureRow()],
			},
		});

		const detail = await playerDetailRepository.getPlayerDetail(context, 9, 3);

		expect(detail?.statsContext.asOfEventId).toBe(3);
		expect(detail?.teamShortName).toBe("BET");
		expect(detail?.transfersInEvent).toBe(1);
		expect(detail?.transfersOutEvent).toBe(2);
	});
});
