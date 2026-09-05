import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	playerDetailCacheKey,
	playerDetailRepository,
} from "../../../src/domains/player-detail/repository";
import { gqlCacheKey } from "../../../src/infra/cache-key";
import {
	buildCorePublication,
	buildSnapshotContext,
	buildTestEventLives,
	buildTestCoreData,
	TestRedis,
} from "../../helpers/data-publication";

type TableRows = Record<string, unknown[]>;

const stable = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
};

const checkpointPayloadEvidence = (value: unknown) => {
	const payload = stable(value);
	return {
		event_live: value,
		event_live_sha256: createHash("sha256").update(payload, "utf8").digest("hex"),
		event_live_count: Array.isArray(value) ? value.length : 0,
		event_live_bytes: Buffer.byteLength(payload, "utf8"),
	};
};

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
	sourceCheckedAt?: string;
	baselineVerifiedAt?: string | null;
	recentAuthority?: boolean;
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
	const sourceCheckedAt = args.sourceCheckedAt ?? new Date().toISOString();
	const publishedAt = new Date().toISOString();
	const baselineVerifiedAt =
		args.baselineVerifiedAt === undefined ? publishedAt : args.baselineVerifiedAt;
	const publicationRows = Array.from({ length: maxPublishedEvent }, (_, eventIndex) => ({
		event_id: eventIndex + 1,
		revision: "11",
		source_checked_at: sourceCheckedAt,
		published_at: publishedAt,
		row_count: core.players.length,
		expected_row_count: core.players.length,
		baseline_verified_at: baselineVerifiedAt,
	}));
	const bundleRows = snapshotRows.map((row) => {
		const publication = publicationRows.find((candidate) => candidate.event_id === row.event_id);
		return {
			...row,
			publication_revision: publication?.revision ?? "11",
			publication_source_checked_at: publication?.source_checked_at ?? sourceCheckedAt,
			publication_published_at: publication?.published_at ?? publishedAt,
			publication_row_count: publication?.row_count ?? core.players.length,
			publication_expected_row_count: publication?.expected_row_count ?? core.players.length,
			publication_content_sha256: "test-player-event-bundle",
			publication_baseline_verified_at: publication?.baseline_verified_at ?? baselineVerifiedAt,
		};
	});
	const tables: TableRows = { ...args.tables };
	const recentRows = [...(tables["fpl.player_gameweek_stats"] ?? [])];
	if (args.recentAuthority !== false && recentRows.length > 0) {
		const checkpointSourceCheckedAt = args.sourceCheckedAt ?? new Date().toISOString();
		const eventIds = [
			...new Set(
				recentRows
					.map((row) => Number((row as { event_id?: unknown }).event_id))
					.filter((eventId) => Number.isSafeInteger(eventId) && eventId > 0)
			),
		];
		const checkpointRows = (tables["competition.live_points_publication_checkpoints"] ??
			eventIds.map((eventId) => ({
				event_id: eventId,
				publication_id: `00000000-0000-4000-8000-${String(eventId).padStart(12, "0")}`,
				generation: "1",
				state: "LIVE_ACTIVE",
				source_checked_at: checkpointSourceCheckedAt,
			}))) as Array<Record<string, unknown>>;
		const normalizedCheckpointRows: Array<Record<string, unknown>> = checkpointRows.map((row) => {
			const eventId = Number(row.event_id);
			const eventLives = buildTestEventLives(core, eventId).map((eventLive) => {
				const recent = recentRows.find((candidate) => {
					const source = candidate as Record<string, unknown>;
					return (
						Number(source.event_id) === eventId &&
						Number(source.element_id ?? 9) === eventLive.elementId
					);
				});
				if (!recent) return eventLive;
				const source = recent as Record<string, unknown>;
				return {
					...eventLive,
					totalPoints: source.total_points ?? eventLive.totalPoints,
					minutes: source.minutes ?? eventLive.minutes,
					starts: source.starts ?? eventLive.starts,
					goalsScored: source.goals_scored ?? eventLive.goalsScored,
					assists: source.assists ?? eventLive.assists,
					cleanSheets: source.clean_sheets ?? eventLive.cleanSheets,
					saves: source.saves ?? eventLive.saves,
					bonus: source.bonus ?? eventLive.bonus,
					bps: source.bps ?? eventLive.bps,
				};
			});
			const evidence = checkpointPayloadEvidence(eventLives);
			return {
				...row,
				checkpointed_at: row.checkpointed_at ?? checkpointSourceCheckedAt,
				...(row.event_live === undefined ? evidence : {}),
			};
		});
		const checkpointsByEvent = new Map(normalizedCheckpointRows.map((row) => [row.event_id, row]));
		tables["competition.live_points_publication_checkpoints"] = normalizedCheckpointRows;
		tables["fpl.player_gameweek_stats"] = recentRows.map((row) => {
			const source = row as Record<string, unknown>;
			const checkpoint = checkpointsByEvent.get(Number(source.event_id));
			return {
				...source,
				publication_id: source.publication_id ?? checkpoint?.publication_id,
				publication_generation: source.publication_generation ?? checkpoint?.generation,
				publication_event_live_sha256:
					source.publication_event_live_sha256 ?? checkpoint?.event_live_sha256,
			};
		});
		if (!tables["fpl.player_fixture_stats"]?.length) {
			tables["fpl.player_fixture_stats"] = eventIds.map((eventId, index) => ({
				season: "2627",
				player_code: 900,
				event_id: eventId,
				fixture_id: index + 1,
				team_id: 1,
			}));
		}
	}
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
				return queryBuilder(tables[table] ?? publicationRows);
			}
			return queryBuilder(tables[table] ?? []);
		},
	} as never;
	context.database = {
		query: async () => ({ rows: tables["fpl.player_fixture_stats"] ?? [] }),
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

	it("memoizes recent checkpoint authority across a player batch", async () => {
		const fromCalls: string[] = [];
		const context = createContext({
			currentEvent: { id: 3, isCurrent: true, finished: false },
			fromCalls,
			tables: {
				"fpl.player_market_snapshots": [marketRow()],
				"fpl.player_event_snapshot_bundles": [
					{ element_id: 9, event_id: 3, total_points: 55 },
					{ element_id: 10, event_id: 3, total_points: 44 },
				],
				"fpl.player_gameweek_stats": [
					{
						element_id: 9,
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
						element_id: 10,
						event_id: 3,
						total_points: 8,
						minutes: 90,
						starts: true,
						goals_scored: 0,
						assists: 1,
						clean_sheets: 1,
						saves: 0,
						bonus: 1,
						bps: 24,
					},
				],
				"fpl.fixtures": [fixtureRow()],
			},
		});

		const details = await playerDetailRepository.getPlayerDetails(context, [9, 10], 3);

		expect(details.get(9)?.dataAvailability.recentGameweeks.state).toBe("READY");
		expect(details.get(10)?.dataAvailability.recentGameweeks.state).toBe("READY");
		expect(
			fromCalls.filter((table) => table === "competition.live_points_publication_checkpoints")
		).toHaveLength(1);
	});

	it("fails closed when a checkpoint event is missing from the player rows", async () => {
		const checkpointSourceCheckedAt = new Date().toISOString();
		const context = createContext({
			currentEvent: { id: 3, isCurrent: true, finished: false },
			tables: {
				"fpl.player_market_snapshots": [marketRow()],
				"fpl.player_event_snapshot_bundles": [{ element_id: 9, event_id: 3, total_points: 55 }],
				"fpl.player_gameweek_stats": [
					{
						element_id: 9,
						event_id: 1,
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
						element_id: 9,
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
				"competition.live_points_publication_checkpoints": [
					{
						event_id: 1,
						publication_id: "00000000-0000-4000-8000-000000000001",
						generation: "1",
						state: "LIVE_ACTIVE",
						source_checked_at: checkpointSourceCheckedAt,
					},
					{
						event_id: 2,
						publication_id: "00000000-0000-4000-8000-000000000002",
						generation: "1",
						state: "LIVE_ACTIVE",
						source_checked_at: checkpointSourceCheckedAt,
					},
					{
						event_id: 3,
						publication_id: "00000000-0000-4000-8000-000000000003",
						generation: "1",
						state: "LIVE_ACTIVE",
						source_checked_at: checkpointSourceCheckedAt,
					},
				],
				"fpl.fixtures": [fixtureRow()],
			},
		});

		const detail = await playerDetailRepository.getPlayerDetail(context, 9, 3);

		expect(detail?.recentGameweeks).toEqual([]);
		expect(detail?.dataAvailability.recentGameweeks).toMatchObject({
			state: "FALLBACK",
			reasonCode: "recent_gameweeks_player_rows_incomplete",
		});
	});

	it("keeps a historical checkpoint when the current Core roster has a late player", async () => {
		const historicalEventLives = buildTestEventLives(buildTestCoreData(3), 1).filter(
			(eventLive) => eventLive.elementId !== 10
		);
		const historicalEvidence = checkpointPayloadEvidence(historicalEventLives);
		const checkpointSourceCheckedAt = new Date().toISOString();
		const context = createContext({
			currentEvent: { id: 3, isCurrent: true, finished: false },
			tables: {
				"fpl.player_market_snapshots": [marketRow()],
				"fpl.player_event_snapshot_bundles": [{ element_id: 9, event_id: 3, total_points: 55 }],
				"fpl.player_gameweek_stats": [
					{
						element_id: 9,
						event_id: 1,
						total_points: 0,
						minutes: 0,
						starts: false,
						goals_scored: 0,
						assists: 0,
						clean_sheets: 0,
						saves: 0,
						bonus: 0,
						bps: 0,
					},
					{
						element_id: 9,
						event_id: 3,
						total_points: 0,
						minutes: 0,
						starts: false,
						goals_scored: 0,
						assists: 0,
						clean_sheets: 0,
						saves: 0,
						bonus: 0,
						bps: 0,
					},
				],
				"competition.live_points_publication_checkpoints": [
					{
						event_id: 1,
						publication_id: "00000000-0000-4000-8000-000000000001",
						generation: "1",
						state: "LIVE_ACTIVE",
						source_checked_at: checkpointSourceCheckedAt,
						...historicalEvidence,
					},
					{
						event_id: 3,
						publication_id: "00000000-0000-4000-8000-000000000003",
						generation: "1",
						state: "LIVE_ACTIVE",
						source_checked_at: checkpointSourceCheckedAt,
					},
				],
				"fpl.fixtures": [fixtureRow()],
			},
		});

		const detail = await playerDetailRepository.getPlayerDetail(context, 9, 3);

		expect(detail?.dataAvailability.recentGameweeks.state).toBe("READY");
		expect(detail?.recentGameweeks.map((row) => row.eventId)).toEqual([3, 1]);
	});

	it("fails closed when an extra oldest event row is hidden by the recent-row limit", async () => {
		const recentRows = Array.from({ length: 5 }, (_, index) => ({
			element_id: 9,
			event_id: index + 2,
			total_points: 0,
			minutes: 0,
			starts: false,
			goals_scored: 0,
			assists: 0,
			clean_sheets: 0,
			saves: 0,
			bonus: 0,
			bps: 0,
		}));
		const context = createContext({
			currentEvent: { id: 6, isCurrent: true, finished: false },
			tables: {
				"fpl.player_market_snapshots": [marketRow()],
				"fpl.player_event_snapshot_bundles": [{ element_id: 9, event_id: 6, total_points: 55 }],
				"fpl.player_gameweek_stats": [...recentRows, recentRows[0]],
				"fpl.fixtures": [fixtureRow()],
			},
		});

		const detail = await playerDetailRepository.getPlayerDetail(context, 9, 6);

		expect(detail?.recentGameweeks).toEqual([]);
		expect(detail?.dataAvailability.recentGameweeks).toMatchObject({
			state: "FALLBACK",
			reasonCode: "recent_gameweeks_player_rows_incomplete",
		});
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
		expect(detail?.dataAvailability.recentGameweeks).toMatchObject({
			state: "READY",
			revision: expect.stringMatching(/^recent-v1:[0-9a-f]{64}$/) as unknown,
			sourceCheckedAt: expect.any(String) as unknown,
		});
	});

	it("marks mutable recent gameweeks non-authoritative and excludes the shared cache", async () => {
		const fromCalls: string[] = [];
		const context = createContext({
			currentEvent: { id: 3, isCurrent: true, finished: false },
			fromCalls,
			recentAuthority: false,
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
		const redis = context.redis as unknown as TestRedis;

		expect(detail?.recentGameweeks).toEqual([]);
		expect(detail?.dataAvailability.recentGameweeks).toMatchObject({
			state: "FALLBACK",
			reasonCode: "recent_gameweeks_publication_missing",
			revision: null,
			sourceCheckedAt: null,
		});
		expect(detail?.dataAvailability.isFullyAuthoritative).toBe(false);
		expect(fromCalls).not.toContain("fpl.player_gameweek_stats");
		expect(redis.setCalls.some(([key]) => key.includes("player-detail"))).toBe(false);
	});

	it("retains a complete stale season snapshot and marks recent rows stale", async () => {
		const staleAt = new Date(Date.now() - 27 * 60 * 60 * 1000).toISOString();
		const context = createContext({
			currentEvent: { id: 3, isCurrent: true, finished: false },
			sourceCheckedAt: staleAt,
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

		expect(detail?.statsContext.status).toBe("STALE");
		expect(detail?.totalPoints).toBe(55);
		expect(detail?.dataAvailability.seasonStats).toMatchObject({
			state: "STALE",
			reasonCode: "season_stats_stale",
			sourceCheckedAt: staleAt,
		});
		expect(detail?.recentGameweeks[0]).toMatchObject({ eventId: 3, totalPoints: 9 });
		expect(detail?.dataAvailability.recentGameweeks).toMatchObject({
			state: "STALE",
			reasonCode: "recent_stats_stale",
		});
	});

	it("keeps an empty mutable recent-gameweek read non-authoritative", async () => {
		const context = createContext({
			currentEvent: { id: 3, isCurrent: true, finished: false },
			tables: {
				"fpl.player_market_snapshots": [marketRow()],
				"fpl.player_event_snapshot_bundles": [{ element_id: 9, event_id: 3, total_points: 55 }],
				"fpl.fixtures": [fixtureRow()],
			},
		});
		const redis = context.redis as unknown as TestRedis;

		const detail = await playerDetailRepository.getPlayerDetail(context, 9, 3);

		expect(detail?.recentGameweeks).toEqual([]);
		expect(detail?.dataAvailability.recentGameweeks).toEqual({
			state: "FALLBACK",
			reasonCode: "recent_gameweeks_publication_missing",
			revision: null,
			sourceCheckedAt: null,
		});
		expect(detail?.dataAvailability.isFullyAuthoritative).toBe(false);
		expect(redis.setCalls.some(([key]) => key.includes("player-detail"))).toBe(false);
	});

	it("fails closed when a recent row is bound to a different checkpoint", async () => {
		const context = createContext({
			currentEvent: { id: 3, isCurrent: true, finished: false },
			tables: {
				"fpl.player_market_snapshots": [marketRow()],
				"fpl.player_event_snapshot_bundles": [{ element_id: 9, event_id: 3, total_points: 55 }],
				"fpl.player_gameweek_stats": [
					{
						event_id: 3,
						publication_id: "00000000-0000-4000-8000-000000000099",
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

		expect(detail?.recentGameweeks).toEqual([]);
		expect(detail?.dataAvailability.recentGameweeks).toMatchObject({
			state: "FALLBACK",
			reasonCode: "recent_gameweeks_publication_mismatch",
			revision: expect.stringMatching(/^recent-v1:/) as unknown,
		});
	});

	it("fails closed when checkpoint event-live evidence is corrupt", async () => {
		const eventLives = buildTestEventLives(buildTestCoreData(3), 3);
		const evidence = checkpointPayloadEvidence(eventLives);
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
						clean_sheets: 1,
						saves: 0,
						bonus: 2,
						bps: 31,
					},
				],
				"competition.live_points_publication_checkpoints": [
					{
						event_id: 3,
						publication_id: "00000000-0000-4000-8000-000000000003",
						generation: "1",
						state: "LIVE_ACTIVE",
						source_checked_at: new Date().toISOString(),
						...evidence,
						event_live_bytes: evidence.event_live_bytes + 1,
					},
				],
				"fpl.fixtures": [fixtureRow()],
			},
		});

		const detail = await playerDetailRepository.getPlayerDetail(context, 9, 3);

		expect(detail?.recentGameweeks).toEqual([]);
		expect(detail?.dataAvailability.recentGameweeks).toMatchObject({
			state: "FALLBACK",
			reasonCode: "recent_gameweeks_publication_invalid",
		});
	});

	it("fails closed when a checksum-valid checkpoint omits core players", async () => {
		const core = buildTestCoreData(3);
		const eventLives = buildTestEventLives(core, 3).slice(0, -1);
		const evidence = checkpointPayloadEvidence(eventLives);
		const context = createContext({
			currentEvent: { id: 3, isCurrent: true, finished: false },
			tables: {
				"fpl.player_market_snapshots": [marketRow()],
				"fpl.player_event_snapshot_bundles": [{ element_id: 9, event_id: 3, total_points: 55 }],
				"fpl.player_gameweek_stats": [
					{
						element_id: 9,
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
				"competition.live_points_publication_checkpoints": [
					{
						event_id: 3,
						publication_id: "00000000-0000-4000-8000-000000000003",
						generation: "1",
						state: "LIVE_ACTIVE",
						source_checked_at: new Date().toISOString(),
						...evidence,
					},
				],
				"fpl.fixtures": [fixtureRow()],
			},
		});

		const detail = await playerDetailRepository.getPlayerDetail(context, 9, 3);

		expect(detail?.recentGameweeks).toEqual([]);
		expect(detail?.dataAvailability.recentGameweeks).toMatchObject({
			state: "FALLBACK",
			reasonCode: "recent_gameweeks_publication_invalid",
		});
	});

	it("fails closed when projected stats diverge from checkpoint event-live", async () => {
		const core = buildTestCoreData(3);
		const evidence = checkpointPayloadEvidence(buildTestEventLives(core, 3));
		const context = createContext({
			currentEvent: { id: 3, isCurrent: true, finished: false },
			tables: {
				"fpl.player_market_snapshots": [marketRow()],
				"fpl.player_event_snapshot_bundles": [{ element_id: 9, event_id: 3, total_points: 55 }],
				"fpl.player_gameweek_stats": [
					{
						element_id: 9,
						event_id: 3,
						total_points: 99,
						minutes: 0,
						starts: false,
						goals_scored: 0,
						assists: 0,
						clean_sheets: 0,
						saves: 0,
						bonus: 0,
						bps: 0,
					},
				],
				"competition.live_points_publication_checkpoints": [
					{
						event_id: 3,
						publication_id: "00000000-0000-4000-8000-000000000003",
						generation: "1",
						state: "LIVE_ACTIVE",
						source_checked_at: new Date().toISOString(),
						...evidence,
					},
				],
				"fpl.fixtures": [fixtureRow()],
			},
		});

		const detail = await playerDetailRepository.getPlayerDetail(context, 9, 3);

		expect(detail?.recentGameweeks).toEqual([]);
		expect(detail?.dataAvailability.recentGameweeks).toMatchObject({
			state: "FALLBACK",
			reasonCode: "recent_gameweeks_publication_mismatch",
		});
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
			recentAuthority: false,
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
			reasonCode: "recent_gameweeks_publication_missing",
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
			recentAuthority: false,
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
			recentAuthority: false,
			tables: {
				"fpl.player_market_snapshots": [marketRow()],
				"fpl.player_event_snapshot_bundles": [{ element_id: 9, event_id: 3 }],
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
		const redis = context.redis as unknown as TestRedis;
		const key = gqlCacheKey(context, playerDetailCacheKey(9, 3));
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
		expect(detail?.dataAvailability.recentGameweeks).toMatchObject({
			state: "FALLBACK",
			reasonCode: "recent_gameweeks_publication_missing",
			revision: null,
			sourceCheckedAt: null,
		});
		expect(detail?.dataAvailability.isFullyAuthoritative).toBe(false);
		expect(redis.setCalls.some(([cachedKey]) => cachedKey.includes("player-detail"))).toBe(false);
	});

	it("does not read the pre-hard-cut player-detail cache namespace", async () => {
		const args = {
			currentEvent: null,
			lifecycleState: "preseason" as const,
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
		};
		const sourceContext = createContext(args);
		const source = await playerDetailRepository.getPlayerDetail(sourceContext, 9, 1);
		if (!source) throw new Error("expected preseason player detail");

		const context = createContext(args);
		const redis = context.redis as unknown as TestRedis;
		const legacyKey = gqlCacheKey(context, "player-detail:9:1");
		redis.values.set(legacyKey, JSON.stringify({ ...source, webName: "Legacy cached name" }));

		const detail = await playerDetailRepository.getPlayerDetail(context, 9, 1);

		expect(detail?.webName).toBe("Test Player");
		expect(redis.values.has(legacyKey)).toBe(true);
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
		const key = gqlCacheKey(nextContext, playerDetailCacheKey(9, 3));
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

	it("invalidates a cached detail when the recent checkpoint generation changes", async () => {
		const context = createContext({
			currentEvent: { id: 3, isCurrent: true, finished: false },
			tables: {
				"fpl.player_market_snapshots": [marketRow()],
				"fpl.player_event_snapshot_bundles": [{ element_id: 9, event_id: 3 }],
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
		const authoritative = await playerDetailRepository.getPlayerDetail(context, 9, 3);
		if (!authoritative) throw new Error("expected authoritative player detail");

		const nextContext = createContext({
			currentEvent: { id: 3, isCurrent: true, finished: false },
			tables: {
				"fpl.player_market_snapshots": [marketRow()],
				"fpl.player_event_snapshot_bundles": [{ element_id: 9, event_id: 3 }],
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
				"competition.live_points_publication_checkpoints": [
					{
						event_id: 3,
						publication_id: "00000000-0000-4000-8000-000000000003",
						generation: "2",
						state: "LIVE_ACTIVE",
						source_checked_at: new Date().toISOString(),
						event_live_sha256: "a".repeat(64),
						event_live_count: 220,
					},
				],
			},
		});
		const redis = nextContext.redis as unknown as TestRedis;
		const key = gqlCacheKey(nextContext, playerDetailCacheKey(9, 3));
		redis.values.set(key, JSON.stringify(authoritative));
		let deleteCount = 0;
		const originalDelete = redis.del;
		redis.del = async (...keys: string[]) => {
			deleteCount += 1;
			return originalDelete(...keys);
		};

		const detail = await playerDetailRepository.getPlayerDetail(nextContext, 9, 3);

		expect(deleteCount).toBe(1);
		expect(detail?.dataAvailability.recentGameweeks.revision).not.toBe(
			authoritative.dataAvailability.recentGameweeks.revision
		);
		expect(detail?.dataAvailability.recentGameweeks.revision).toEqual(
			expect.stringMatching(/^recent-v1:/)
		);
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
