import { describe, expect, it } from "bun:test";
import { playerDetailRepository } from "../../../src/domains/player-detail/repository";

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
	const cache = new Map<string, string>([["Season:active", "2627"]]);
	const redis = {
		get: async (key: string) => {
			if (key === "event:current") {
				return args.currentEvent ? JSON.stringify(args.currentEvent) : null;
			}
			return cache.get(key) ?? null;
		},
		hget: async (key: string, field: string) => {
			if (key === "Player:2627" && field === "9") {
				return JSON.stringify({
					code: 900,
					webName: "Test Player",
					teamId: 1,
					type: 3,
					price: 75,
					startPrice: 70,
					selectedByPercent: "8.5",
				});
			}
			return null;
		},
		hgetall: async (key: string) => {
			if (key === "Team:2627") {
				return {
					"1": JSON.stringify({ id: 1, code: 1, name: "Alpha", shortName: "ALP" }),
					"2": JSON.stringify({ id: 2, code: 2, name: "Beta", shortName: "BET" }),
					"3": JSON.stringify({ id: 3, code: 3, name: "Gamma", shortName: "GAM" }),
				};
			}
			return {};
		},
		mget: async (...keys: string[]) => keys.map(() => null),
		set: async (key: string, value: string) => {
			cache.set(key, value);
			return "OK";
		},
		del: async (key: string) => (cache.delete(key) ? 1 : 0),
		pipeline: () => ({
			set: (key: string, value: string) => {
				cache.set(key, value);
			},
			exec: async () => [],
		}),
	};
	return {
		redis,
		supabase: {
			from: (table: string) => {
				fromCalls.push(table);
				return queryBuilder(args.tables[table] ?? []);
			},
		},
		logger: { warn: () => undefined, error: () => undefined },
	} as never;
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
	it("gates season production during preseason but keeps current market and fixtures", async () => {
		const fromCalls: string[] = [];
		const context = createContext({
			currentEvent: null,
			fromCalls,
			tables: {
				events: [
					{
						id: 1,
						finished: false,
						is_current: false,
						deadline_time_epoch: Math.floor(Date.now() / 1000) + 86_400,
					},
				],
				player_market_snapshots: [marketRow()],
				event_fixtures: [fixtureRow({ event_id: 1 })],
				player_stats: [{ element_id: 9, event_id: 1, total_points: 200 }],
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
		expect(detail?.fixtures).toHaveLength(1);
		expect(detail?.fixtures.filter((fixture) => fixture.bgw)).toHaveLength(0);
		expect(fromCalls).not.toContain("player_stats");
		expect(fromCalls).not.toContain("event_lives");
	});

	it("marks live points provisional when Redis has no current-event row", async () => {
		const context = createContext({
			currentEvent: null,
			tables: {
				events: [
					{
						id: 3,
						finished: false,
						is_current: true,
						deadline_time_epoch: Math.floor(Date.now() / 1000) - 60,
					},
				],
				player_market_snapshots: [marketRow()],
				player_stats: [{ element_id: 9, event_id: 3, total_points: 55 }],
				event_lives: [
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
				event_fixtures: [fixtureRow()],
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
				player_market_snapshots: [marketRow({ status: "d", news: "Knock" })],
				player_stats: [
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
				event_lives: [
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
				event_fixtures: [
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
				events: [
					{
						id: 3,
						finished: true,
						is_current: false,
						deadline_time_epoch: Math.floor(Date.now() / 1000) - 86_400,
					},
				],
				player_market_snapshots: [marketRow()],
				player_stats: [
					{
						element_id: 9,
						event_id: 3,
						total_points: 55,
						transfers_in_event: 1,
						transfers_out_event: 2,
					},
				],
				event_lives: [
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
				event_fixtures: [fixtureRow()],
			},
		});

		const detail = await playerDetailRepository.getPlayerDetail(context, 9, 3);

		expect(detail?.statsContext.asOfEventId).toBe(3);
		expect(detail?.transfersInEvent).toBe(1);
		expect(detail?.transfersOutEvent).toBe(2);
	});
});
