import { describe, expect, it } from "bun:test";
import { GraphQLError } from "graphql";
import type { QueryResultRow } from "pg";
import type { QueryExecutor } from "../../src/infra/database";
import { CurrentSeasonProvider, getCurrentSeason, loadCurrentSeason } from "../../src/infra/season";

const executorWithRows = (
	rows: QueryResultRow[],
	onQuery: () => void = () => undefined
): QueryExecutor => ({
	query: async () => {
		onQuery();
		return { rows, rowCount: rows.length } as never;
	},
});

describe("PostgreSQL current-season authority", () => {
	it("loads the one explicit current season", async () => {
		await expect(
			loadCurrentSeason(executorWithRows([{ season_id: 2025, season_code: "2526" }]))
		).resolves.toEqual({ seasonId: 2025, seasonCode: "2526" });
	});

	it("rejects missing, duplicate, and malformed current-season rows", async () => {
		await expect(loadCurrentSeason(executorWithRows([]))).rejects.toBeInstanceOf(GraphQLError);
		await expect(
			loadCurrentSeason(
				executorWithRows([
					{ season_id: 2025, season_code: "2526" },
					{ season_id: 2026, season_code: "2627" },
				])
			)
		).rejects.toBeInstanceOf(GraphQLError);
		await expect(
			loadCurrentSeason(executorWithRows([{ season_id: 2025, season_code: "invalid" }]))
		).rejects.toBeInstanceOf(GraphQLError);
	});

	it("rejects database failures without consulting Redis", async () => {
		const database: QueryExecutor = {
			query: async () => {
				throw new Error("offline");
			},
		};
		await expect(loadCurrentSeason(database)).rejects.toBeInstanceOf(GraphQLError);
	});

	it("holds an immutable startup-authoritative season without database refresh", () => {
		const provider = new CurrentSeasonProvider();
		expect(() => provider.get()).toThrow(GraphQLError);
		provider.seed({ seasonId: 2026, seasonCode: "2627" });
		expect(provider.get()).toEqual({ seasonId: 2026, seasonCode: "2627" });
		expect(provider.get()).toEqual({ seasonId: 2026, seasonCode: "2627" });
	});

	it("reads request context season metadata without a Redis fallback", async () => {
		const context = {
			currentSeason: { seasonId: 2026, seasonCode: "2627" },
		} as never;
		await expect(getCurrentSeason(context)).resolves.toBe("2627");
	});
});
