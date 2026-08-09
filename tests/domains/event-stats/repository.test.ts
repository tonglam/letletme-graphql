import { describe, expect, it } from "bun:test";
import {
	eventStatsRepository,
	getTournamentSelectionStatsReadModel,
	type DbTournamentSelectionStatRow,
	type TournamentSelectionStats,
} from "../../../src/domains/event-stats/repository";
import type { GraphQLContext } from "../../../src/graphql/context";

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

const PLAYERS = new Map([
	[1, { code: 101, webName: "Keeper", teamId: 1, type: 1 }],
	[2, { code: 102, webName: "Defender", teamId: 1, type: 2 }],
	[3, { code: 103, webName: "Midfielder", teamId: 2, type: 3 }],
	[4, { code: 104, webName: "Forward", teamId: 2, type: 4 }],
]);

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
		error?: unknown;
		cached?: TournamentSelectionStats;
	} = {}
): TestContext {
	const cacheKey = "gql:v2:2526:tournament-selection-stats:1:10:10";
	const strings = new Map<string, string>();
	if (options.cached) strings.set(cacheKey, JSON.stringify(options.cached));
	const readModels: string[] = [];
	let directDatabaseReads = 0;

	return {
		currentSeason: { seasonId: 2025, seasonCode: "2526" },
		database: {
			query: async () => {
				directDatabaseReads += 1;
				throw new Error("Tournament selections must not aggregate source tables at read time");
			},
		},
		redis: {
			get: async (key: string) => strings.get(key) ?? null,
			set: async (key: string, value: string) => {
				strings.set(key, value);
				return "OK";
			},
			del: async (key: string) => (strings.delete(key) ? 1 : 0),
			hmget: async (_key: string, ...ids: string[]) =>
				ids.map((id) => {
					const player = PLAYERS.get(Number(id));
					return player ? JSON.stringify(player) : null;
				}),
			hgetall: async () => ({
				"1": JSON.stringify({ id: 1, name: "Alpha", shortName: "ALP" }),
				"2": JSON.stringify({ id: 2, name: "Beta", shortName: "BET" }),
			}),
		},
		data: {
			read: (model: string) => {
				readModels.push(model);
				if (model === "reporting.tournament_selection_stats") {
					return makeQuery({ data: options.rows ?? [], error: options.error ?? null });
				}
				return makeQuery({ data: [], error: null });
			},
		},
		logger: { warn: () => undefined, error: () => undefined },
		__cache: strings,
		__readModels: readModels,
		__directDatabaseReads: () => directDatabaseReads,
	} as unknown as TestContext;
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
});
