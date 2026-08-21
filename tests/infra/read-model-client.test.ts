import { describe, expect, it } from "bun:test";
import type { QueryResultRow } from "pg";
import type { QueryExecutor } from "../../src/infra/database";
import { READ_MODELS, ReadModelClient, type ReadModel } from "../../src/infra/read-model-client";

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

const clientFor = (executor: QueryExecutor): ReadModelClient =>
	new ReadModelClient(executor, { seasonId: 2026, seasonCode: "2627" });

describe("Data Platform read client", () => {
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

		expect(() => client.read("fpl.players; DROP TABLE fpl.players" as ReadModel)).toThrow(
			"Unknown Data Platform read model"
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

	it("projects tournament setup reliability fields for repository reads", async () => {
		const { executor, queries } = makeExecutor();
		const fields = [
			"setup_progress_indeterminate",
			"setup_attempt",
			"setup_max_attempts",
			"setup_next_retry_at",
			"profiles_ready_at",
			"insights_ready_at",
		] as const;

		await clientFor(executor).read("competition.tournaments").select(fields.join(", "));

		const query = queries[0]?.text ?? "";
		for (const field of fields) {
			expect(query.match(new RegExp("\\b" + field + "\\b", "g"))?.length).toBeGreaterThanOrEqual(2);
		}
	});

	it("probes every registered model at the current season and exposes a unique relation set", async () => {
		const { executor, queries } = makeExecutor();
		await clientFor(executor).probe();

		expect(queries).toHaveLength(Object.keys(READ_MODELS).length);
		expect(queries.every((query) => query.values[0] === 2026)).toBe(true);
		expect(queries.every((query) => query.text.includes("LIMIT 0"))).toBe(true);

		const relations = ReadModelClient.sourceRelations();
		expect(relations).toEqual([...relations].sort());
		expect(new Set(relations).size).toBe(relations.length);
		expect(relations).toContain("fpl.players");
		expect(relations).toContain("reporting.player_season_summaries");
		expect(relations).toContain("reporting.tournament_selection_stats");
		expect(relations).toContain("understat.seasons");
		expect(relations).toContain("understat.player_seasons");
		expect(relations).toContain("bridge.entity_links");
		const playerStateProbe = queries.find((query) =>
			query.text.includes("FROM reporting.player_state_season_rows")
		);
		expect(playerStateProbe?.text).toContain("fpl_total_points");
		expect(playerStateProbe?.text).toContain("fpl_starts");
		expect(playerStateProbe?.text).toContain("fpl_clean_sheets");
		expect(playerStateProbe?.text).toContain("fpl_saves");
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

	it("uses the season-safe joined entry league read model", async () => {
		const { executor, queries } = makeExecutor();

		await clientFor(executor)
			.read("competition.entry_leagues_with_tournament")
			.select("league_id, tournament_id, tournament_name")
			.eq("entry_id", 123)
			.eq("league_type", "h2h");

		expect(queries).toHaveLength(1);
		expect(queries[0]?.values).toEqual([2026, 123, "h2h"]);
		expect(queries[0]?.text).toContain("LEFT JOIN LATERAL");
		expect(queries[0]?.text).toContain("season_id = entry_league.season_id");
		expect(queries[0]?.text).toContain("league_type = entry_league.league_type");
	});

	it("returns market snapshot dates as calendar-date text", async () => {
		const { executor, queries } = makeExecutor();

		await clientFor(executor).read("fpl.player_market_snapshots").select("snapshot_date");

		expect(queries[0]?.text).toContain("snapshot_date::text AS snapshot_date");
	});
});
