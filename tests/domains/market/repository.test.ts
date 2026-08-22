import { describe, expect, it } from "bun:test";
import {
	buildMarketAvailabilityPage,
	buildMarketPulse,
	createMarketRepository,
	emptyMarketPulse,
	type MarketSnapshotRow,
} from "../../../src/domains/market/repository";
import { gqlCacheKey } from "../../../src/infra/cache-key";
import {
	buildSnapshotContext,
	createTestPublication,
	TestRedis,
} from "../../helpers/data-publication";

const baseRow = (
	date: string,
	elementId: number,
	overrides: Partial<MarketSnapshotRow> = {}
): MarketSnapshotRow => ({
	snapshot_date: date,
	captured_at: `${date}T01:40:00.000Z`,
	element_id: elementId,
	player_code: 1000 + elementId,
	web_name: `Player ${elementId}`,
	team_id: 1,
	team_name: "Arsenal",
	team_short_name: "ARS",
	element_type: 3,
	position: "MID",
	price: 70,
	selected_by_percent: 10,
	transfers_in: 0,
	transfers_out: 0,
	status: "a",
	news: "",
	news_added: null,
	chance_of_playing_this_round: 100,
	chance_of_playing_next_round: 100,
	baseline_date: "2026-08-01",
	first_observed_date: "2026-08-01",
	previous_price: null,
	previous_transfers_in: null,
	previous_transfers_out: null,
	previous_status: null,
	previous_news: null,
	previous_chance_this_round: null,
	previous_chance_next_round: null,
	...overrides,
});

const buildContext = (cacheSeed?: string) => {
	const strings = new Map<string, string>();
	const writes: Array<{ key: string; value: string; ttl: number }> = [];
	const deletes: string[] = [];
	const context = {
		currentSeason: { seasonId: 2026, seasonCode: "2627" },
		dataRevision: "core-test",
		redis: {
			get: async (key: string) => strings.get(key) ?? null,
			set: async (key: string, value: string, _mode: string, ttl: number) => {
				strings.set(key, value);
				writes.push({ key, value, ttl });
				return "OK";
			},
			del: async (key: string) => {
				strings.delete(key);
				deletes.push(key);
				return 1;
			},
		},
		logger: { warn: () => undefined, error: () => undefined },
		data: {},
	} as never;
	if (cacheSeed !== undefined) {
		strings.set(gqlCacheKey(context, "market-pulse:v4:7"), cacheSeed);
	}
	return {
		strings,
		writes,
		deletes,
		context,
	};
};

describe("buildMarketPulse", () => {
	it("returns an honest no-observation response", () => {
		expect(buildMarketPulse([], 14)).toEqual(emptyMarketPulse(14));
	});

	it("builds movers without treating newcomers or counter resets as jumps", () => {
		const rows: MarketSnapshotRow[] = [
			baseRow("2026-08-01", 1, { selected_by_percent: 10 }),
			baseRow("2026-08-01", 2, {
				selected_by_percent: 20,
				transfers_in: 10,
				status: "d",
				news: "Knock - 50% chance of playing",
			}),
			baseRow("2026-08-03", 1, {
				selected_by_percent: 15,
				price: 71,
				previous_price: 70,
				transfers_in: 10,
				transfers_out: 2,
				previous_transfers_in: 0,
				previous_transfers_out: 0,
				status: "d",
				previous_status: "a",
				news: "Hamstring injury",
				previous_news: "",
				news_added: "2026-08-02T08:00:00Z",
				previous_chance_this_round: 100,
				chance_of_playing_this_round: 25,
			}),
			baseRow("2026-08-03", 2, {
				selected_by_percent: 15,
				transfers_in: 1,
				previous_transfers_in: 10,
				previous_transfers_out: 0,
				status: "a",
				previous_status: "d",
				news: "",
				previous_news: "Knock - 50% chance of playing",
				previous_chance_this_round: 50,
				chance_of_playing_this_round: 100,
			}),
			baseRow("2026-08-03", 3, {
				web_name: "New signing",
				selected_by_percent: 30,
				first_observed_date: "2026-08-03",
			}),
		];

		const pulse = buildMarketPulse(rows, 3, new Date("2026-08-03T12:00:00Z"));

		expect(pulse.coverage).toMatchObject({
			requestedDays: 3,
			observedDays: 2,
			firstDate: "2026-08-01",
			latestDate: "2026-08-03",
			complete: false,
			stale: false,
		});
		expect(pulse.coverage.missingDates).toEqual(["2026-08-02"]);
		expect(pulse.mostSelected[0].playerId).toBe(3);
		expect(pulse.transferMovers).toHaveLength(1);
		expect(pulse.transferMovers[0]).toMatchObject({
			transfersIn: 10,
			transfersOut: 2,
			netTransfers: 8,
		});
		expect(pulse.availabilityUpdates.map((update) => update.player.playerId).sort()).toEqual([
			1, 2,
		]);
		expect(pulse.newPlayers).toHaveLength(1);
		expect(pulse.newPlayers[0]).toMatchObject({ firstObservedDate: "2026-08-03" });
		expect(pulse.priceChanges).toHaveLength(1);
		expect(pulse.priceChanges[0]).toMatchObject({
			oldPrice: 70,
			newPrice: 71,
			change: 1,
			direction: "RISE",
		});
	});

	it("marks the requested observed calendar days complete and old captures stale", () => {
		const rows = Array.from({ length: 14 }, (_, index) => {
			const date = `2026-08-${String(index + 1).padStart(2, "0")}`;
			return baseRow(date, 1, {
				previous_price: index === 0 ? null : 70,
				previous_transfers_in: index === 0 ? null : 0,
				previous_transfers_out: index === 0 ? null : 0,
				previous_status: index === 0 ? null : "a",
				previous_news: index === 0 ? null : "",
				previous_chance_this_round: index === 0 ? null : 100,
				previous_chance_next_round: index === 0 ? null : 100,
			});
		});

		const pulse = buildMarketPulse(rows, 14, new Date("2026-08-16T00:00:00Z"));
		expect(pulse.coverage).toMatchObject({
			observedDays: 14,
			complete: true,
			stale: true,
		});
	});

	it("dates official news using the UTC+8 market calendar", () => {
		const pulse = buildMarketPulse(
			[
				baseRow("2026-08-02", 1, {
					news: "Late official update",
					news_added: "2026-08-01T16:30:00.000Z",
				}),
			],
			1,
			new Date("2026-08-02T03:00:00.000Z")
		);

		expect(pulse.availabilityUpdates).toHaveLength(1);
		expect(pulse.availabilityUpdates[0]?.observedDate).toBe("2026-08-02");
	});

	it("preserves PostgreSQL calendar dates without shifting them to UTC", () => {
		const snapshotDate = new Date(2026, 7, 3);
		const pulse = buildMarketPulse(
			[
				baseRow("2026-08-03", 1, {
					snapshot_date: snapshotDate,
					baseline_date: snapshotDate,
					first_observed_date: snapshotDate,
				}),
			],
			14,
			new Date("2026-08-03T12:00:00.000Z")
		);

		expect(pulse.coverage.firstDate).toBe("2026-08-03");
		expect(pulse.coverage.latestDate).toBe("2026-08-03");
	});

	it("does not let an out-of-window news timestamp override an observed status change", () => {
		const pulse = buildMarketPulse(
			[
				baseRow("2026-08-03", 1, {
					status: "d",
					previous_status: "a",
					news: "Future-dated upstream notice",
					news_added: "2026-08-04T08:00:00.000Z",
				}),
			],
			1,
			new Date("2026-08-03T12:00:00.000Z")
		);

		expect(pulse.availabilityUpdates).toHaveLength(1);
		expect(pulse.availabilityUpdates[0]?.observedDate).toBe("2026-08-03");
	});

	it("computes deterministic highlights before truncating the 20-row update list", () => {
		const rows = Array.from({ length: 22 }, (_, index) => {
			const elementId = index + 1;
			return baseRow("2026-08-03", elementId, {
				selected_by_percent: 100 - elementId,
				status: elementId === 22 ? "i" : "a",
				previous_status: elementId === 22 ? "a" : "d",
				chance_of_playing_this_round: elementId === 22 ? 0 : 100,
				previous_chance_this_round: elementId === 22 ? 100 : 50,
			});
		});

		const pulse = buildMarketPulse(rows, 14, new Date("2026-08-03T12:00:00Z"));
		expect(pulse.availabilityUpdates).toHaveLength(20);
		expect(pulse.availabilityEvidence).toHaveLength(22);
		expect(pulse.availabilityUpdates.some((item) => item.player.playerId === 22)).toBe(false);
		expect(pulse.availabilityHighlights).toHaveLength(5);
		expect(pulse.availabilityHighlights[0]?.player.playerId).toBe(22);
	});

	it("uses only the latest capture when a player has multiple snapshots on one day", () => {
		const pulse = buildMarketPulse(
			[
				baseRow("2026-08-03", 1, {
					captured_at: "2026-08-03T01:00:00.000Z",
					selected_by_percent: 80,
				}),
				baseRow("2026-08-03", 1, {
					captured_at: "2026-08-03T02:00:00.000Z",
					selected_by_percent: 12,
				}),
			],
			14
		);

		expect(pulse.mostSelected).toHaveLength(1);
		expect(pulse.mostSelected[0]).toMatchObject({ playerId: 1, selectedByPercent: 12 });
		expect(pulse.coverage.capturedAt).toBe("2026-08-03T02:00:00.000Z");
	});

	it("paginates the complete availability evidence without losing the total", () => {
		const pulse = buildMarketPulse(
			Array.from({ length: 45 }, (_, index) =>
				baseRow("2026-08-03", index + 1, {
					selected_by_percent: 100 - index,
					status: "i",
					previous_status: "a",
					chance_of_playing_this_round: 0,
					previous_chance_this_round: 100,
				})
			),
			14
		);
		const context = {
			season: "2627",
			revision: "market:1",
			source: "POSTGRES_FALLBACK" as const,
			snapshotDate: "2026-08-03",
			capturedAt: "2026-08-03T01:40:00.000Z",
			rowCount: 45,
			cacheTtlSeconds: 300,
		};

		const first = buildMarketAvailabilityPage(pulse, context, 20, 0);
		const second = buildMarketAvailabilityPage(pulse, context, 20, first.nextOffset!);
		const third = buildMarketAvailabilityPage(pulse, context, 20, second.nextOffset!);

		expect(first.items).toHaveLength(20);
		expect(second.items).toHaveLength(20);
		expect(third.items).toHaveLength(5);
		expect(third.nextOffset).toBeNull();
		expect(
			[...first.items, ...second.items, ...third.items].map((item) => item.player.playerId)
		).toEqual(Array.from({ length: 45 }, (_, index) => index + 1));
		expect(first.totalCount).toBe(45);
		expect(second.totalCount).toBe(45);
		expect(third.totalCount).toBe(45);
	});
});

describe("market repository caching", () => {
	it("caches a successful pulse for the five-minute market policy", async () => {
		const context = buildContext();
		const repository = createMarketRepository({
			query: async () => ({ rows: [baseRow("2026-08-03", 1)] }),
		});

		const result = await repository.getMarketPulse(context.context, 14);
		expect(result.coverage.observedDays).toBe(1);
		expect(context.writes[0]?.ttl).toBe(300);
	});

	it("caches a no-data pulse for five minutes", async () => {
		const context = buildContext();
		const repository = createMarketRepository({ query: async () => ({ rows: [] }) });

		const result = await repository.getMarketPulse(context.context, 14);
		expect(result.coverage.observedDays).toBe(0);
		expect(context.writes[0]?.ttl).toBe(300);
	});

	it("coalesces concurrent cache misses into one database query", async () => {
		const context = buildContext();
		let queries = 0;
		let release!: () => void;
		let markStarted!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const repository = createMarketRepository({
			query: async () => {
				queries += 1;
				markStarted();
				await gate;
				return { rows: [baseRow("2026-08-03", 1)] };
			},
		});

		const reads = Array.from({ length: 20 }, () => repository.getMarketPulse(context.context, 14));
		await started;
		expect(queries).toBe(1);
		release();
		const results = await Promise.all(reads);

		expect(queries).toBe(1);
		expect(context.writes).toHaveLength(1);
		expect(results.every((result) => result === results[0])).toBe(true);
	});

	it("returns a shaped cache without querying the database", async () => {
		const context = buildContext(JSON.stringify(emptyMarketPulse(7)));
		let queries = 0;
		const repository = createMarketRepository({
			query: async () => {
				queries += 1;
				return { rows: [] };
			},
		});

		expect(await repository.getMarketPulse(context.context, 7)).toEqual(emptyMarketPulse(7));
		expect(queries).toBe(0);
	});

	it("propagates database failures instead of returning empty market data", async () => {
		const context = buildContext();
		const repository = createMarketRepository({
			query: async () => {
				throw new Error("database unavailable");
			},
		});

		await expect(repository.getMarketPulse(context.context, 14)).rejects.toThrow(
			"Failed to query market snapshots"
		);
		expect(context.writes).toHaveLength(0);
	});

	it("re-pins after a query observes that the selected latest capture was overwritten", async () => {
		const capturedAt = "2026-08-20T01:40:00.000Z";
		const publication = createTestPublication({ dataset: "fpl:market", seasonCode: "2627" }, 21, {
			context: {
				seasonCode: "2627",
				snapshotDate: "2026-08-20",
				capturedAt,
				rowCount: 1,
			},
		});
		const context = buildSnapshotContext(new TestRedis(publication), {
			databaseQuery: async () => ({
				rows: [
					{
						snapshot_date: "2026-08-20",
						captured_at: capturedAt,
						row_count: 1,
						capture_count: 1,
					},
				],
			}),
		});
		let reads = 0;
		const repository = createMarketRepository({
			query: async () => ({
				rows:
					reads++ === 0
						? [baseRow("2026-08-19", 1)]
						: [baseRow("2026-08-20", 1, { captured_at: capturedAt })],
			}),
		});

		const result = await repository.getMarketPulse(context, 14);
		expect(result.coverage.latestDate).toBe("2026-08-20");
		expect(reads).toBe(2);
		expect((context.redis as unknown as TestRedis).setCalls.at(-1)?.slice(-2)).toEqual([
			"EX",
			86_400,
		]);
	});
});
