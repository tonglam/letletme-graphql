import { describe, expect, it } from "bun:test";
import { playerDetailRepository } from "../../../src/domains/player-detail/repository";
import {
	buildCorePublication,
	buildSnapshotContext,
	buildTestCoreData,
	TestRedis,
} from "../../helpers/data-publication";

type TableRows = Record<string, unknown[]>;

const queryBuilder = (rows: unknown[]) => {
	const result = { data: rows, error: null };
	const builder = {
		select: () => builder,
		eq: () => builder,
		lte: () => builder,
		in: () => builder,
		or: () => builder,
		order: () => builder,
		limit: () => builder,
		range: () => builder,
		then: <TResult1 = typeof result, TResult2 = never>(
			onfulfilled?: ((value: typeof result) => TResult1 | PromiseLike<TResult1>) | null,
			onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
		) => Promise.resolve(result).then(onfulfilled, onrejected),
	};
	return builder;
};

function createContext(args: {
	currentEvent: Record<string, unknown> | null;
	tables: TableRows;
	fromCalls?: string[];
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
	const context = buildSnapshotContext(new TestRedis(buildCorePublication("2627", 7, core)), {
		dataRevision: "core-7",
	});
	context.data = {
		read: (table: string) => {
			fromCalls.push(table);
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
				"fpl.player_event_snapshots": [{ element_id: 9, event_id: 1, total_points: 200 }],
			},
		});

		const detail = await playerDetailRepository.getPlayerDetail(context, 9, 1);

		expect(detail?.statsContext).toEqual({
			scope: "UNAVAILABLE",
			season: "2627",
			asOfEventId: null,
		});
		expect(detail?.totalPoints).toBeNull();
		expect(detail?.form).toBeNull();
		expect(detail?.selectedByPercent).toBe(12.5);
		expect(detail?.transfersInEvent).toBe(321);
		expect(detail?.availability?.status).toBe("a");
		expect(detail?.recentGameweeks).toEqual([]);
		expect(detail?.fixtures).toHaveLength(38);
		expect(detail?.fixtures.filter((fixture) => fixture.bgw)).toHaveLength(0);
		expect(fromCalls).not.toContain("fpl.player_event_snapshots");
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
				"fpl.player_event_snapshots": [{ element_id: 9, event_id: 3, total_points: 55 }],
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

		expect(detail?.statsContext).toEqual({
			scope: "CURRENT_SEASON",
			season: "2627",
			asOfEventId: 3,
		});
		expect(detail?.recentGameweeks[0]?.provisional).toBe(true);
	});

	it("returns nullable season stats, latest market data, recent GWs and every DGW fixture", async () => {
		const context = createContext({
			currentEvent: { id: 3, isCurrent: true, finished: false },
			tables: {
				"fpl.player_market_snapshots": [marketRow({ status: "d", news: "Knock" })],
				"fpl.player_event_snapshots": [
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

		expect(detail?.statsContext).toEqual({
			scope: "CURRENT_SEASON",
			season: "2627",
			asOfEventId: 3,
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
				"fpl.player_event_snapshots": [
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
