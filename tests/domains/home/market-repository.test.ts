import { describe, expect, it } from "bun:test";
import {
	createHomeMarketRepository,
	HOME_MARKET_AVAILABILITY_SQL,
	HOME_MARKET_OWNERSHIP_SQL,
	HOME_MARKET_PRICE_CHANGES_SQL,
} from "../../../src/domains/home/market-repository";
import {
	buildSnapshotContext,
	createTestPublication,
	TestRedis,
} from "../../helpers/data-publication";

const capturedAt = "2026-08-20T01:02:03.000Z";

const contextFor = () =>
	buildSnapshotContext(
		new TestRedis(
			createTestPublication({ dataset: "fpl:market", seasonCode: "2627" }, 17, {
				context: {
					seasonCode: "2627",
					snapshotDate: "2026-08-20",
					capturedAt,
					rowCount: 30,
				},
			})
		),
		{
			databaseQuery: async () => ({
				rows: [
					{
						snapshot_date: "2026-08-20",
						captured_at: capturedAt,
						row_count: 30,
						capture_count: 1,
					},
				],
			}),
		}
	);

const player = (id: number, selectedByPercent = 10) => ({
	element_id: id,
	player_code: 1000 + id,
	web_name: `Player ${id}`,
	team_id: 1,
	team_name: "Arsenal",
	team_short_name: "ARS",
	element_type: 3,
	position: "MID",
	price: 70,
	selected_by_percent: selectedByPercent,
});

describe("Home market desk", () => {
	it("runs three bounded queries in parallel and maps compact results", async () => {
		const context = contextFor();
		const calls: string[] = [];
		const repository = createHomeMarketRepository({
			query: async (sql) => {
				calls.push(sql);
				if (sql === HOME_MARKET_OWNERSHIP_SQL) {
					return {
						rows: [
							{
								...player(1, 12),
								from_selected_by_percent: 10,
								to_selected_by_percent: 12,
								change_percentage_points: 2,
								from_date: "2026-08-19",
								to_date: "2026-08-20",
								captured_at: capturedAt,
								direction: "RISE",
							},
							{
								...player(2, 8),
								from_selected_by_percent: 10,
								to_selected_by_percent: 8,
								change_percentage_points: -2,
								from_date: "2026-08-19",
								to_date: "2026-08-20",
								captured_at: capturedAt,
								direction: "FALL",
							},
						],
					};
				}
				if (sql === HOME_MARKET_PRICE_CHANGES_SQL) {
					return {
						rows: [
							{
								...player(3),
								change_date: "2026-08-20",
								old_price: 70,
								new_price: 71,
								change: 1,
								direction: "RISE",
							},
						],
					};
				}
				return {
					rows: [
						{
							...player(4, 15),
							status: "d",
							previous_status: "a",
							news: "Knock",
							news_added: "2026-08-20T00:00:00.000Z",
							observed_date: "2026-08-20",
							chance_of_playing_this_round: 50,
							chance_of_playing_next_round: 75,
						},
					],
				};
			},
		});

		const result = await repository.getDesk(context);

		expect(calls).toHaveLength(3);
		expect(result).toMatchObject({
			revision: "core-7.market-17",
			capturedAt,
			ownershipState: "AVAILABLE",
			priceChangesState: "AVAILABLE",
			availabilityState: "AVAILABLE",
		});
		expect(result.ownership?.risers.map((row) => row.player.playerId)).toEqual([1]);
		expect(result.ownership?.fallers.map((row) => row.player.playerId)).toEqual([2]);
		expect(result.priceChanges.map((row) => row.player.playerId)).toEqual([3]);
		expect(result.availabilityUpdates.map((row) => row.player.playerId)).toEqual([4]);
	});

	it("keeps one failed market subsection isolated and does not cache the partial desk", async () => {
		const context = contextFor();
		const writes: string[] = [];
		const redis = context.redis as unknown as TestRedis;
		const originalSet = redis.set.bind(redis);
		redis.set = async (...args: Parameters<TestRedis["set"]>) => {
			writes.push(args[0]);
			return originalSet(...args);
		};
		const repository = createHomeMarketRepository({
			query: async (sql) => {
				if (sql === HOME_MARKET_AVAILABILITY_SQL) throw new Error("availability unavailable");
				return { rows: [] };
			},
		});

		const result = await repository.getDesk(context);

		expect(result).toMatchObject({
			ownershipState: "EMPTY",
			priceChangesState: "EMPTY",
			availabilityState: "UNAVAILABLE",
			priceChanges: [],
			availabilityUpdates: [],
		});
		expect(result.ownership).toBeNull();
		expect(writes).toHaveLength(0);
	});

	it("returns empty states for a coherent snapshot with no changes", async () => {
		const context = contextFor();
		const repository = createHomeMarketRepository({ query: async () => ({ rows: [] }) });

		const result = await repository.getDesk(context);

		expect(result.ownershipState).toBe("EMPTY");
		expect(result.priceChangesState).toBe("EMPTY");
		expect(result.availabilityState).toBe("EMPTY");
	});

	it("uses one request flight for concurrent consumers and keeps SQL bounded", async () => {
		const context = contextFor();
		let queries = 0;
		const repository = createHomeMarketRepository({
			query: async (sql) => {
				queries += 1;
				expect(sql).not.toContain("jsonb_agg");
				expect(sql).toContain("ROW_NUMBER");
				return { rows: [] };
			},
		});

		await Promise.all([repository.getDesk(context), repository.getDesk(context)]);

		expect(queries).toBe(3);
	});
});
