import { describe, expect, it } from "bun:test";
import type { TournamentSelectionStats } from "../../../src/domains/event-stats/repository";
import { createPublicLeagueTrendsRepository } from "../../../src/domains/public-league-trends/repository";

const emptyStats: TournamentSelectionStats = {
	totalEntries: 10,
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

const context = (options: { failRedisWrites?: boolean } = {}) => {
	const strings = new Map<string, string>([["Season:active", "2627"]]);
	return {
		strings,
		value: {
			redis: {
				get: async (key: string) => strings.get(key) ?? null,
				set: async (key: string, value: string) => {
					if (options.failRedisWrites) throw new Error("redis unavailable");
					strings.set(key, value);
					return "OK";
				},
				del: async (key: string) => (strings.delete(key) ? 1 : 0),
			},
			logger: { warn: () => undefined, error: () => undefined },
			supabase: {},
		} as never,
	};
};

describe("public league trends repository", () => {
	it("safely returns an empty catalog while its migration is unavailable", async () => {
		let reads = 0;
		const repository = createPublicLeagueTrendsRepository(
			{
				query: async () => ({ rows: [{ catalog: null }] }),
			},
			async () => {
				reads += 1;
				return emptyStats;
			}
		);
		const ctx = context();
		expect(await repository.list(ctx.value)).toEqual([]);
		expect(await repository.getSelectionStats(ctx.value, 1, 1, 12)).toBeNull();
		expect(reads).toBe(0);
	});

	it("lists only the catalog query projection and maps its public fields", async () => {
		const repository = createPublicLeagueTrendsRepository({
			query: async (sql) => {
				if (sql.includes("to_regclass"))
					return { rows: [{ catalog: "public_league_trends_catalog" }] };
				return {
					rows: [
						{
							tournament_id: 7,
							display_name: "Perth FPL",
							sort_order: 2,
							published_at: "2026-08-01T00:00:00.000Z",
							updated_at: "2026-08-08T00:00:00.000Z",
							latest_event_id: 3,
							total_entries: 125,
							catalog_revision: "2026-08-08T00:00:00.000Z",
						},
					],
				};
			},
		});
		const result = await repository.list(context().value);
		expect(result).toEqual([
			{
				tournamentId: 7,
				displayName: "Perth FPL",
				sortOrder: 2,
				publishedAt: "2026-08-01T00:00:00.000Z",
				updatedAt: "2026-08-08T00:00:00.000Z",
				latestAvailableEventId: 3,
				totalEntries: 125,
			},
		]);
	});

	it("authorizes every public snapshot and changes the cache key with its revision", async () => {
		let revision = "2026-08-08T01:00:00.000Z";
		let reads = 0;
		const repository = createPublicLeagueTrendsRepository(
			{
				query: async (sql) => {
					if (sql.includes("to_regclass")) {
						return { rows: [{ catalog: "public_league_trends_catalog" }] };
					}
					return {
						rows: [
							{
								catalog_revision: "2026-08-08T00:00:00.000Z",
								snapshot_revision: revision,
							},
						],
					};
				},
			},
			async (_context, tournamentId, eventId, limit) => {
				reads += 1;
				expect([tournamentId, eventId, limit]).toEqual([7, 3, 12]);
				return emptyStats;
			}
		);
		const ctx = context();
		expect(await repository.getSelectionStats(ctx.value, 7, 3, 12)).toEqual(emptyStats);
		expect(await repository.getSelectionStats(ctx.value, 7, 3, 12)).toEqual(emptyStats);
		expect(reads).toBe(1);

		revision = "2026-08-08T02:00:00.000Z";
		expect(await repository.getSelectionStats(ctx.value, 7, 3, 12)).toEqual(emptyStats);
		expect(reads).toBe(2);
	});

	it("returns public catalog rows when Redis cache writes fail", async () => {
		const repository = createPublicLeagueTrendsRepository({
			query: async (sql) => {
				if (sql.includes("to_regclass")) {
					return { rows: [{ catalog: "public_league_trends_catalog" }] };
				}
				return {
					rows: [
						{
							tournament_id: 7,
							display_name: "Perth FPL",
							sort_order: 2,
							published_at: "2026-08-01T00:00:00.000Z",
							updated_at: "2026-08-08T00:00:00.000Z",
							latest_event_id: 3,
							total_entries: 125,
							catalog_revision: "2026-08-08T00:00:00.000Z",
						},
					],
				};
			},
		});

		const result = await repository.list(context({ failRedisWrites: true }).value);
		expect(result[0]?.tournamentId).toBe(7);
	});

	it("returns public selection stats when Redis cache writes fail", async () => {
		const repository = createPublicLeagueTrendsRepository(
			{
				query: async (sql) => {
					if (sql.includes("to_regclass")) {
						return { rows: [{ catalog: "public_league_trends_catalog" }] };
					}
					return {
						rows: [
							{
								catalog_revision: "2026-08-08T00:00:00.000Z",
								snapshot_revision: "2026-08-08T01:00:00.000Z",
							},
						],
					};
				},
			},
			async () => emptyStats
		);

		const result = await repository.getSelectionStats(
			context({ failRedisWrites: true }).value,
			7,
			3,
			12
		);
		expect(result).toEqual(emptyStats);
	});
});
