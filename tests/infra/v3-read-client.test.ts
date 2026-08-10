import { describe, expect, it } from "bun:test";
import type { QueryResultRow } from "pg";
import type { QueryExecutor } from "../../src/infra/database";
import { V3_READ_MODELS, V3ReadClient, type V3ReadModel } from "../../src/infra/v3-read-client";

type RecordedQuery = Readonly<{
	text: string;
	values: readonly unknown[];
}>;

const makeExecutor = (
	rows: readonly QueryResultRow[] = []
): Readonly<{ executor: QueryExecutor; queries: RecordedQuery[] }> => {
	const queries: RecordedQuery[] = [];
	const executor: QueryExecutor = {
		query: async (text, values = []) => {
			queries.push({ text, values });
			return { rows: [...rows], rowCount: rows.length } as never;
		},
	};
	return { executor, queries };
};

const clientFor = (executor: QueryExecutor): V3ReadClient =>
	new V3ReadClient(executor, { seasonId: 2026, seasonCode: "2627" });

describe("Data Platform v3 read client", () => {
	it("binds season, filters, and OR values without interpolating caller input", async () => {
		const { executor, queries } = makeExecutor([{ id: 1 }]);
		const maliciousValue = "1 OR TRUE --";

		const result = await clientFor(executor)
			.read("fpl.players")
			.select("id, web_name")
			.eq("team_id", 3)
			.in("type", [2, 3])
			.not("price", "is", null)
			.or(`first_name.eq.${maliciousValue},second_name.eq.safe`)
			.order("id", { ascending: false, nullsFirst: false })
			.range(10, 19);

		expect(result).toEqual({ data: [{ id: 1 }], error: null });
		expect(queries).toHaveLength(1);
		expect(queries[0].values).toEqual([2026, 3, [2, 3], maliciousValue, "safe"]);
		expect(queries[0].text).toContain('SELECT "id", "web_name"');
		expect(queries[0].text).toContain('"team_id" = $2');
		expect(queries[0].text).toContain('"type" = ANY($3)');
		expect(queries[0].text).toContain('"price" IS NOT NULL');
		expect(queries[0].text).toContain('("first_name" = $4 OR "second_name" = $5)');
		expect(queries[0].text).toContain('ORDER BY "id" DESC NULLS LAST LIMIT 10 OFFSET 10');
		expect(queries[0].text).not.toContain(maliciousValue);
	});

	it("rejects unregistered models and unsafe identifiers before querying", () => {
		const { executor, queries } = makeExecutor();
		const client = clientFor(executor);

		expect(() => client.read("fpl.players; DROP TABLE fpl.players" as V3ReadModel)).toThrow(
			"Unknown Data Platform v3 read model"
		);
		expect(() => client.read("fpl.players").select("id, now()")).toThrow(
			"Invalid read-model identifier"
		);
		expect(() => client.read("fpl.players").eq("id OR TRUE", 1)).toThrow(
			"Invalid read-model identifier"
		);
		expect(() => client.read("fpl.players").or("id.eq.1")).toThrow(
			"Read-model OR requires at least two clauses"
		);
		expect(queries).toHaveLength(0);
	});

	it("implements maybeSingle without hiding cardinality violations", async () => {
		const one = makeExecutor([{ id: 1 }]);
		await expect(clientFor(one.executor).read("fpl.players").maybeSingle()).resolves.toEqual({
			data: { id: 1 },
			error: null,
		});

		const many = makeExecutor([{ id: 1 }, { id: 2 }]);
		await expect(clientFor(many.executor).read("fpl.players").maybeSingle()).resolves.toEqual({
			data: null,
			error: { code: "PGRST116", message: "Expected at most one row" },
		});
	});

	it("returns bounded PostgreSQL error metadata", async () => {
		const failure = Object.assign(new Error("column is unavailable"), {
			code: "42703",
			detail: "missing test column",
		});
		const executor: QueryExecutor = {
			query: async () => {
				throw failure;
			},
		};

		const result = await clientFor(executor).read("fpl.players").select("id");
		expect(result).toEqual({
			data: null,
			error: {
				message: "column is unavailable",
				code: "42703",
				details: "missing test column",
			},
		});
	});

	it("probes every registered model at the current season and exposes a unique relation set", async () => {
		const { executor, queries } = makeExecutor();
		await clientFor(executor).probe();

		expect(queries).toHaveLength(Object.keys(V3_READ_MODELS).length);
		expect(queries.every((query) => query.values[0] === 2026)).toBe(true);
		expect(queries.every((query) => query.text.includes("LIMIT 0"))).toBe(true);

		const relations = V3ReadClient.sourceRelations();
		expect(relations).toEqual([...relations].sort());
		expect(new Set(relations).size).toBe(relations.length);
		expect(relations).toContain("fpl.players");
		expect(relations).toContain("reporting.player_season_summaries");
		expect(relations).toContain("reporting.tournament_selection_stats");
		expect(relations).toContain("understat.seasons");
		expect(relations).toContain("understat.player_seasons");
		expect(relations).toContain("bridge.entity_links");
	});

	it("projects tournament season rank from the canonical points-group result", async () => {
		const { executor, queries } = makeExecutor();

		await clientFor(executor)
			.read("reporting.tournament_entry_event_summaries")
			.select("tournament_id, tournament_overall_rank")
			.eq("tournament_id", 7)
			.eq("event_id", 3);

		expect(queries).toHaveLength(1);
		expect(queries[0].text).toContain("group_result.event_group_rank AS tournament_overall_rank");
		expect(queries[0].text).toContain(
			"LEFT JOIN competition.tournament_points_group_results group_result"
		);
		expect(queries[0].text).not.toContain(
			"summary.tournament_event_rank AS tournament_overall_rank"
		);
	});
});
