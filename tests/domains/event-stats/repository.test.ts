import { describe, expect, it } from "bun:test";
import {
	eventStatsRepository,
	getTournamentSelectionIndexRows,
	getTournamentSelectionStatsReadModel,
	TOURNAMENT_SELECTION_INDEX_SQL,
	type DbTournamentSelectionStatRow,
	type TournamentSelectionStats,
} from "../../../src/domains/event-stats/repository";
import type { GraphQLContext } from "../../../src/graphql/context";
import { gqlCacheKey } from "../../../src/infra/cache-key";
import {
	buildCorePublication,
	buildSnapshotContext,
	buildTestCoreData,
	TestRedis,
} from "../../helpers/data-publication";

const EMPTY_STATS: TournamentSelectionStats = {
	totalEntries: 0,
	goalkeepers: [],
	defenders: [],
	midfielders: [],
	forwards: [],
	captainSelect: [],
	viceCaptainSelect: [],
	mostSelectedPlayers: [],
	mostTransferIn: [],
	mostTransferOut: [],
};

const ROWS: DbTournamentSelectionStatRow[] = [
	{
		element_id: 1,
		pick_count: 8,
		captain_count: 0,
		vice_captain_count: 0,
		transfer_in_count: 1,
		transfer_out_count: 0,
		total_entries: 10,
		selection_percentage: 80,
		captain_percentage: 0,
		vice_captain_percentage: 0,
		effective_ownership_percentage: 65.4321,
	},
	{
		element_id: 2,
		pick_count: 7,
		captain_count: 1,
		vice_captain_count: 2,
		transfer_in_count: 0,
		transfer_out_count: 2,
		total_entries: 10,
		selection_percentage: 70,
		captain_percentage: 10,
		vice_captain_percentage: 20,
		effective_ownership_percentage: 80,
	},
	{
		element_id: 3,
		pick_count: 6,
		captain_count: 6,
		vice_captain_count: 3,
		transfer_in_count: 5,
		transfer_out_count: 1,
		total_entries: 10,
		selection_percentage: 60,
		captain_percentage: 60,
		vice_captain_percentage: 30,
		effective_ownership_percentage: 135.6789,
	},
	{
		element_id: 4,
		pick_count: 5,
		captain_count: 3,
		vice_captain_count: 5,
		transfer_in_count: 2,
		transfer_out_count: 4,
		total_entries: 10,
		selection_percentage: 50,
		captain_percentage: 30,
		vice_captain_percentage: 50,
		effective_ownership_percentage: 80,
	},
];

const SELECTION_INDEX_ROWS = ROWS.map((row) => ({
	publication_id: "1",
	expected_entries: "10",
	complete_pick_entries: "10",
	revision: "7",
	publication_state: "READY",
	ownership_state: "READY",
	captaincy_state: "READY",
	vice_captaincy_state: "READY",
	transfers_state: "READY",
	element_id: row.element_id,
	selected_count: row.pick_count,
	effective_selection_count: row.pick_count,
	captain_count: row.captain_count,
	vice_captain_count: row.vice_captain_count,
	transfer_in_count: row.transfer_in_count,
	transfer_out_count: row.transfer_out_count,
	player_name: `Player ${row.element_id}`,
	player_position: row.element_id,
	team_short_name: "GCT",
}));

const makeQuery = (result: { data: unknown[] | null; error: unknown }) => {
	const promise = Promise.resolve(result);
	type Builder = typeof promise & {
		select: () => Builder;
		eq: () => Builder;
		in: () => Builder;
		lte: () => Builder;
		order: () => Builder;
		limit: () => Builder;
	};
	const builder = promise as Builder;
	Object.assign(builder, {
		select: () => builder,
		eq: () => builder,
		in: () => builder,
		lte: () => builder,
		order: () => builder,
		limit: () => builder,
	});
	return builder;
};

type TestContext = GraphQLContext & {
	__cache: Map<string, string>;
	__readModels: string[];
	__directDatabaseReads: () => number;
};

function createContext(
	options: {
		rows?: DbTournamentSelectionStatRow[];
		selectionRows?: unknown[];
		error?: unknown;
		cached?: TournamentSelectionStats;
	} = {}
): TestContext {
	const core = buildTestCoreData(10);
	const redis = new TestRedis(buildCorePublication("2526", 7, core));
	const readModels: string[] = [];
	let directDatabaseReads = 0;
	const context = buildSnapshotContext(redis, {
		seasonId: 2025,
		seasonCode: "2526",
		dataRevision: "core-test",
	}) as TestContext;
	context.database = {
		query: async (text: string) => {
			directDatabaseReads += 1;
			if (text === TOURNAMENT_SELECTION_INDEX_SQL) {
				return { rows: options.selectionRows ?? [] };
			}
			throw new Error("Tournament selections must not aggregate source tables at read time");
		},
	} as never;
	context.data = {
		read: (model: string) => {
			readModels.push(model);
			if (model === "reporting.tournament_selection_stats") {
				return makeQuery({ data: options.rows ?? [], error: options.error ?? null });
			}
			return makeQuery({ data: [], error: null });
		},
	} as never;
	context.__cache = redis.values;
	context.__readModels = readModels;
	context.__directDatabaseReads = () => directDatabaseReads;
	if (options.cached) {
		redis.values.set(
			gqlCacheKey(context, "tournament-selection-stats:1:10:10"),
			JSON.stringify(options.cached)
		);
	}
	return context;
}

describe("eventStatsRepository tournament selection materialized view", () => {
	it("returns empty stats for invalid identifiers without touching dependencies", async () => {
		await expect(
			eventStatsRepository.getTournamentSelectionStats({} as never, 0, 10, 10)
		).resolves.toEqual(EMPTY_STATS);
		await expect(
			eventStatsRepository.getTournamentSelectionStats({} as never, 1, -1, 10)
		).resolves.toEqual(EMPTY_STATS);
	});

	it("returns a valid query-cache hit without reading the materialized view", async () => {
		const cached = { ...EMPTY_STATS, totalEntries: 99 };
		const context = createContext({ rows: ROWS, cached });

		await expect(
			eventStatsRepository.getTournamentSelectionStats(context, 1, 10, 10)
		).resolves.toEqual(cached);
		expect(context.__readModels).toEqual([]);
	});

	it("ignores a malformed query-cache payload and reads the materialized view", async () => {
		const context = createContext({ rows: ROWS });
		context.__cache.set(
			gqlCacheKey(context, "tournament-selection-stats:1:10:10"),
			JSON.stringify({ totalEntries: 99 })
		);

		const result = await eventStatsRepository.getTournamentSelectionStats(context, 1, 10, 10);
		const cacheKey = gqlCacheKey(context, "tournament-selection-stats:1:10:10");
		expect(result.totalEntries).toBe(10);
		expect(context.__readModels).toContain("reporting.tournament_selection_stats");
		expect(JSON.parse(context.__cache.get(cacheKey) ?? "{}")).toMatchObject({ totalEntries: 10 });
	});

	it("builds positional counts and percentages from the materialized view only", async () => {
		const context = createContext({ rows: ROWS });

		const result = await eventStatsRepository.getTournamentSelectionStats(context, 1, 10, 10);

		expect(result.totalEntries).toBe(10);
		expect(result.goalkeepers[0]).toMatchObject({
			id: 1,
			selectedByPercent: 80,
			eoByPercent: 65.43,
		});
		expect(result.defenders[0]).toMatchObject({ id: 2, selectedByPercent: 70 });
		expect(result.midfielders[0]).toMatchObject({ id: 3, selectedByPercent: 60 });
		expect(result.forwards[0]).toMatchObject({ id: 4, selectedByPercent: 50 });
		expect(result.captainSelect[0]).toMatchObject({
			id: 3,
			captainByPercent: 60,
			eoByPercent: 135.68,
		});
		expect(result.viceCaptainSelect[0]).toMatchObject({ id: 4, captainByPercent: 50 });
		expect(result.mostTransferIn[0]).toMatchObject({ id: 3, transfersEvent: 5 });
		expect(result.mostTransferOut[0]).toMatchObject({ id: 4, transfersEvent: 4 });
		expect(context.__readModels).toContain("reporting.tournament_selection_stats");
		expect(context.__directDatabaseReads()).toBe(0);
	});

	it("returns empty stats when no complete MV publication exists", async () => {
		const context = createContext();

		await expect(
			eventStatsRepository.getTournamentSelectionStats(context, 1, 10, 10)
		).resolves.toEqual(EMPTY_STATS);
		expect(context.__directDatabaseReads()).toBe(0);
	});

	it("propagates read-model failures instead of presenting a populated league as empty", async () => {
		const context = createContext({ error: { code: "PGRST000", message: "temporary outage" } });

		await expect(
			eventStatsRepository.getTournamentSelectionStats(context, 1, 10, 10)
		).rejects.toThrow("Failed to fetch tournament selection stats read model");
		expect(context.__directDatabaseReads()).toBe(0);
	});

	it("rejects an MV row with invalid precomputed percentages instead of recomputing it", async () => {
		const rows = ROWS.map((row, index) =>
			index === 0 ? { ...row, effective_ownership_percentage: Number.NaN } : row
		);
		const context = createContext({ rows });

		await expect(
			eventStatsRepository.getTournamentSelectionStats(context, 1, 10, 10)
		).resolves.toEqual(EMPTY_STATS);
		expect(context.__directDatabaseReads()).toBe(0);
	});

	it("keeps the public read path bounded to twelve rows per category", async () => {
		const context = createContext({ rows: ROWS });
		const result = await getTournamentSelectionStatsReadModel(context, 1, 10, 100);

		expect(result?.totalEntries).toBe(10);
		expect(context.__directDatabaseReads()).toBe(0);
	});

	it("projects the live selection index from the immutable reporting publication", async () => {
		const context = createContext({ selectionRows: SELECTION_INDEX_ROWS });
		await expect(getTournamentSelectionIndexRows(context, 1, 10)).resolves.toEqual([
			{ playerId: 1, count: 8, percentage: 80 },
			{ playerId: 2, count: 7, percentage: 70 },
			{ playerId: 3, count: 6, percentage: 60 },
			{ playerId: 4, count: 5, percentage: 50 },
		]);
		expect(context.__readModels).toEqual([]);
		expect(context.__directDatabaseReads()).toBe(1);
	});

	it("fails closed for malformed or inconsistent live selection rows", async () => {
		await expect(
			getTournamentSelectionIndexRows(
				createContext({
					selectionRows: [
						SELECTION_INDEX_ROWS[0]!,
						{ ...SELECTION_INDEX_ROWS[1]!, expected_entries: "9" },
					],
				}),
				1,
				10
			)
		).rejects.toThrow("Inconsistent tournament selection index");
		await expect(
			getTournamentSelectionIndexRows(
				createContext({
					selectionRows: [{ ...SELECTION_INDEX_ROWS[0]!, selected_count: "not-a-count" }],
				}),
				1,
				10
			)
		).rejects.toThrow("Malformed tournament selection index");
		await expect(
			getTournamentSelectionIndexRows(
				createContext({ selectionRows: [SELECTION_INDEX_ROWS[0]!, SELECTION_INDEX_ROWS[0]!] }),
				1,
				10
			)
		).rejects.toThrow("Duplicate tournament selection index player");
	});
});
