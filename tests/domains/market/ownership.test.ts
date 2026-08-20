import { describe, expect, it } from "bun:test";
import { parse, validate } from "graphql";
import type { Event } from "../../../src/domains/events/repository";
import {
	buildMarketOwnershipDay,
	buildMarketOwnershipOverview,
	createMarketOwnershipRepository,
	type MarketOwnershipSnapshotRow,
} from "../../../src/domains/market/ownership-repository";
import { schema } from "../../../src/graphql/schema";
import {
	buildSnapshotContext,
	createTestPublication,
	TestRedis,
} from "../../helpers/data-publication";

const row = (
	date: string,
	elementId: number,
	selectedByPercent: number,
	capturedAt = `${date}T12:00:00.000Z`
): MarketOwnershipSnapshotRow => ({
	snapshot_date: date,
	captured_at: capturedAt,
	element_id: elementId,
	player_code: 1000 + elementId,
	web_name: `Player ${elementId}`,
	team_id: 1,
	team_name: "Arsenal",
	team_short_name: "ARS",
	element_type: 3,
	position: "MID",
	price: 70,
	selected_by_percent: selectedByPercent,
});

const event = (id: number, deadlineTime: string): Event =>
	({
		id,
		name: `GW${id}`,
		deadlineTime,
	}) as Event;

describe("market ownership period contracts", () => {
	it("compares a daily snapshot only with the adjacent natural day", () => {
		const result = buildMarketOwnershipDay(
			[row("2026-08-18", 1, 10), row("2026-08-19", 1, 14), row("2026-08-19", 2, 20)],
			"2026-08-19",
			10,
			new Date("2026-08-19T13:00:00.000Z")
		);

		expect(result.coverage).toMatchObject({
			status: "READY",
			requestedDays: 2,
			observedDays: 2,
			fromDate: "2026-08-18",
			toDate: "2026-08-19",
		});
		expect(result.risers[0]).toMatchObject({
			fromSelectedByPercent: 10,
			toSelectedByPercent: 14,
			changePercentagePoints: 4,
			fromDate: "2026-08-18",
			toDate: "2026-08-19",
		});
		expect(result.fallers).toHaveLength(0);
	});

	it("uses the capture at or before the gameweek deadline for the baseline", () => {
		const result = buildMarketOwnershipOverview(
			[
				row("2026-08-17", 1, 10, "2026-08-17T11:00:00.000Z"),
				row("2026-08-17", 1, 99, "2026-08-17T13:00:00.000Z"),
				row("2026-08-19", 1, 15, "2026-08-19T12:00:00.000Z"),
			],
			"GAMEWEEK",
			10,
			[
				event(1, "2026-08-10T12:00:00.000Z"),
				event(2, "2026-08-17T12:00:00.000Z"),
				event(3, "2026-08-24T12:00:00.000Z"),
			],
			new Date("2026-08-19T13:00:00.000Z")
		);

		expect(result.risers[0]).toMatchObject({
			fromSelectedByPercent: 10,
			toSelectedByPercent: 15,
			changePercentagePoints: 5,
		});
	});

	it("does not calculate a daily change when either endpoint is missing", () => {
		const missingBaseline = buildMarketOwnershipDay(
			[row("2026-08-19", 1, 14)],
			"2026-08-19",
			10,
			new Date("2026-08-19T13:00:00.000Z")
		);
		const missingTarget = buildMarketOwnershipDay(
			[row("2026-08-19", 1, 14)],
			"2026-08-20",
			10,
			new Date("2026-08-20T13:00:00.000Z")
		);

		expect(missingBaseline.coverage.status).toBe("BASELINE_MISSING");
		expect(missingBaseline.risers).toEqual([]);
		expect(missingTarget.coverage.status).toBe("NO_DATA");
		expect(missingTarget.fallers).toEqual([]);
	});

	it("assigns the latest snapshot to the next deadline and compares after the previous deadline", () => {
		const result = buildMarketOwnershipOverview(
			[
				row("2026-08-16", 1, 10, "2026-08-16T12:00:00.000Z"),
				row("2026-08-19", 1, 15, "2026-08-19T12:00:00.000Z"),
			],
			"GAMEWEEK",
			10,
			[
				event(1, "2026-08-10T12:00:00.000Z"),
				event(2, "2026-08-17T12:00:00.000Z"),
				event(3, "2026-08-24T12:00:00.000Z"),
			],
			new Date("2026-08-19T13:00:00.000Z")
		);

		expect(result.gameweek).toMatchObject({ id: 3, name: "GW3" });
		expect(result.coverage).toMatchObject({
			status: "PARTIAL",
			fromDate: "2026-08-16",
			toDate: "2026-08-19",
		});
		expect(result.risers[0]?.changePercentagePoints).toBe(5);
	});

	it("exposes first-gameweek and no-upcoming states without rows", () => {
		const first = buildMarketOwnershipOverview(
			[row("2026-08-01", 1, 10, "2026-08-01T12:00:00.000Z")],
			"GAMEWEEK",
			10,
			[event(1, "2026-08-02T12:00:00.000Z"), event(2, "2026-08-09T12:00:00.000Z")],
			new Date("2026-08-01T13:00:00.000Z")
		);
		const none = buildMarketOwnershipOverview(
			[row("2026-08-25", 1, 10, "2026-08-25T12:00:00.000Z")],
			"GAMEWEEK",
			10,
			[event(1, "2026-08-10T12:00:00.000Z"), event(2, "2026-08-17T12:00:00.000Z")],
			new Date("2026-08-25T13:00:00.000Z")
		);

		expect(first.coverage.status).toBe("NO_PREVIOUS_GAMEWEEK");
		expect(none.coverage.status).toBe("NO_UPCOMING_GAMEWEEK");
	});

	it("loads all ownership rows through one batch query per request scope", async () => {
		const queries: string[] = [];
		const queryValues: unknown[][] = [];
		const values = new Map<string, string>();
		const repository = createMarketOwnershipRepository({
			query: async (sql, parameters) => {
				queries.push(sql);
				queryValues.push(parameters ?? []);
				return { rows: [{ ownership_rows: [row("2026-08-19", 1, 12)] }] };
			},
		});
		const contextData = {
			currentSeason: { seasonId: 2026, seasonCode: "2627" },
			dataRevision: "test",
			requestScope: {},
			redis: {
				get: async (key: string) => values.get(key) ?? null,
				set: async (key: string, value: string) => {
					values.set(key, value);
					return "OK";
				},
			},
			logger: { warn: () => undefined, error: () => undefined },
		};
		const context = contextData as never;

		await repository.getDay(context, null, 10);
		await repository.getDay(context, null, 10);
		expect(queries).toHaveLength(1);
		expect(queries[0]).not.toContain("DISTINCT ON (snapshot_date, element_id)");
		expect(queries[0]).toContain("$3::date");
		expect(queries[0]).toContain("jsonb_agg");

		const cachedRequestContext = {
			...contextData,
			requestScope: {},
		} as never;
		await repository.getDay(cachedRequestContext, null, 10);
		expect(queries).toHaveLength(1);

		const historicalRequestContext = {
			...contextData,
			dataRevision: "historical",
			requestScope: {},
		} as never;
		await repository.getDay(historicalRequestContext, new Date("2020-01-02T00:00:00.000Z"), 10);
		expect(queryValues[1]?.[2]).toBe("2020-01-02");

		const historicalCachedContext = {
			...contextData,
			dataRevision: "historical",
			requestScope: {},
		} as never;
		await repository.getDay(historicalCachedContext, new Date("2020-01-02T00:00:00.000Z"), 10);
		expect(queryValues).toHaveLength(2);

		const multiDateContext = {
			...contextData,
			dataRevision: "multi-date",
			requestScope: {},
		} as never;
		await repository.getDay(multiDateContext, null, 10);
		await repository.getDay(multiDateContext, new Date("2020-01-02T00:00:00.000Z"), 10);
		expect(queryValues).toHaveLength(4);
		expect(queryValues[3]?.[2]).toBe("2020-01-02");
	});
});

describe("market ownership GraphQL schema", () => {
	it("removes the old mover field and validates the new roots", () => {
		const retiredOwnershipField = "ownership" + "Movers";
		const retiredChangeField = "ch" + "ange";
		const oldErrors = validate(
			schema,
			parse(
				`query { marketPulse { ${retiredOwnershipField} { risers { ${retiredChangeField} } } } }`
			)
		);
		expect(oldErrors.map((error) => error.message).join(" ")).toContain("Cannot query field");

		const newErrors = validate(
			schema,
			parse(`
			query {
				marketOwnershipOverview(period: DAILY) {
					period
					coverage { status requestedDays observedDays firstDate latestDate fromDate toDate missingDates capturedAt complete stale }
					risers { player { playerId } fromSelectedByPercent toSelectedByPercent changePercentagePoints fromDate toDate }
					fallers { player { playerId } fromSelectedByPercent toSelectedByPercent changePercentagePoints fromDate toDate }
				}
				marketOwnershipDay { date coverage { status } risers { changePercentagePoints } fallers { changePercentagePoints } }
			}
		`)
		);
		expect(newErrors).toEqual([]);
		expect(schema.getType("MarketOwnershipOverview")).toBeDefined();
		expect(schema.getType("MarketOwnershipDay")).toBeDefined();
		expect(schema.getType("MarketOwnershipCoverageStatus")).toBeDefined();
	});
});

describe("market ownership snapshot pinning", () => {
	it("retries when the pinned latest capture is missing from the query result", async () => {
		const capturedAt = "2026-08-20T12:00:00.000Z";
		const publication = createTestPublication({ dataset: "fpl:market", seasonCode: "2627" }, 22, {
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
		const repository = createMarketOwnershipRepository({
			query: async () => ({
				rows: [
					{
						ownership_rows: [
							reads++ === 0 ? row("2026-08-19", 1, 10) : row("2026-08-20", 1, 12, capturedAt),
						],
					},
				],
			}),
		});

		const result = await repository.getOverview(context, "DAILY", 10);
		expect(result.coverage.toDate).toBe("2026-08-20");
		expect(reads).toBe(2);
		expect((context.redis as unknown as TestRedis).setCalls.at(-1)?.slice(-2)).toEqual([
			"EX",
			86_400,
		]);
	});
});
