import { describe, expect, it } from "bun:test";
import type { TournamentSelectionStats } from "../../../src/domains/event-stats/repository";
import {
	PUBLIC_LEAGUE_ACCESS_SQL,
	PUBLIC_LEAGUE_CATALOG_SQL,
	PUBLIC_LEAGUE_SELECTION_SQL,
	createPublicLeagueTrendsRepository,
} from "../../../src/domains/public-league-trends/repository";

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

const selectionPublicationRow = (overrides: Record<string, unknown> = {}) => ({
	publication_id: "1",
	expected_entries: 10,
	revision: "1",
	ownership_state: "READY",
	captaincy_state: "READY",
	vice_captaincy_state: "READY",
	transfers_state: "READY",
	element_id: null,
	selected_count: null,
	effective_selection_count: null,
	captain_count: null,
	vice_captain_count: null,
	transfer_in_count: null,
	transfer_out_count: null,
	player_name: null,
	player_position: null,
	team_short_name: null,
	...overrides,
});

const context = (options: { failRedisWrites?: boolean } = {}) => {
	const strings = new Map<string, string>();
	return {
		strings,
		value: {
			currentSeason: { seasonId: 2026, seasonCode: "2627" },
			dataRevision: "core-test",
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
			data: {},
		} as never,
	};
};

describe("public league trends repository", () => {
	it("returns an empty catalog when no public league is enabled", async () => {
		let reads = 0;
		const repository = createPublicLeagueTrendsRepository({
			query: async () => {
				reads += 1;
				return { rows: [] };
			},
		});
		const ctx = context();
		expect(await repository.list(ctx.value)).toEqual([]);
		expect(await repository.getSelectionStats(ctx.value, 1, 1, 12)).toBeNull();
		expect(reads).toBe(2);
	});

	it("lists only the catalog query projection and maps its public fields", async () => {
		const repository = createPublicLeagueTrendsRepository({
			query: async (sql) => {
				if (sql === PUBLIC_LEAGUE_CATALOG_SQL) {
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
				}
				throw new Error(`unexpected SQL: ${sql}`);
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
		const repository = createPublicLeagueTrendsRepository({
			query: async (sql) => {
				if (sql === PUBLIC_LEAGUE_ACCESS_SQL) {
					return {
						rows: [
							{
								catalog_revision: "2026-08-08T00:00:00.000Z",
								snapshot_revision: revision,
							},
						],
					};
				}
				if (sql === PUBLIC_LEAGUE_SELECTION_SQL) {
					reads += 1;
					return { rows: [selectionPublicationRow()] };
				}
				throw new Error(`unexpected SQL: ${sql}`);
			},
		});
		const ctx = context();
		expect(await repository.getSelectionStats(ctx.value, 7, 3, 12)).toEqual(emptyStats);
		expect(await repository.getSelectionStats(ctx.value, 7, 3, 12)).toEqual(emptyStats);
		expect(reads).toBe(1);

		revision = "2026-08-08T02:00:00.000Z";
		expect(await repository.getSelectionStats(ctx.value, 7, 3, 12)).toEqual(emptyStats);
		expect(reads).toBe(2);
	});

	it("invalidates the catalog when its visible selection snapshot changes", async () => {
		let totalEntries = 125;
		const repository = createPublicLeagueTrendsRepository({
			query: async (sql) => {
				if (sql === PUBLIC_LEAGUE_CATALOG_SQL) {
					return {
						rows: [
							{
								tournament_id: 7,
								display_name: "Perth FPL",
								sort_order: 1,
								published_at: "2026-08-01T00:00:00.000Z",
								updated_at: "2026-08-08T00:00:00.000Z",
								latest_event_id: 3,
								total_entries: totalEntries,
								catalog_revision: "2026-08-08T00:00:00.000Z",
							},
						],
					};
				}
				throw new Error(`unexpected SQL: ${sql}`);
			},
		});
		const ctx = context();
		expect(await repository.list(ctx.value)).toHaveLength(1);
		expect(await repository.list(ctx.value)).toHaveLength(1);
		totalEntries = 126;
		expect((await repository.list(ctx.value))[0]?.totalEntries).toBe(126);
		// The third call writes under the new visible-snapshot fingerprint.
		expect(ctx.strings.size).toBe(2);
	});

	it("returns public catalog rows when Redis cache writes fail", async () => {
		const repository = createPublicLeagueTrendsRepository({
			query: async (sql) => {
				if (sql === PUBLIC_LEAGUE_CATALOG_SQL) {
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
				}
				throw new Error(`unexpected SQL: ${sql}`);
			},
		});

		const result = await repository.list(context({ failRedisWrites: true }).value);
		expect(result[0]?.tournamentId).toBe(7);
	});

	it("returns public selection stats when Redis cache writes fail", async () => {
		const repository = createPublicLeagueTrendsRepository({
			query: async (sql) => {
				if (sql === PUBLIC_LEAGUE_ACCESS_SQL) {
					return {
						rows: [
							{
								catalog_revision: "2026-08-08T00:00:00.000Z",
								snapshot_revision: "2026-08-08T01:00:00.000Z",
							},
						],
					};
				}
				if (sql === PUBLIC_LEAGUE_SELECTION_SQL) {
					return { rows: [selectionPublicationRow()] };
				}
				throw new Error(`unexpected SQL: ${sql}`);
			},
		});

		const result = await repository.getSelectionStats(
			context({ failRedisWrites: true }).value,
			7,
			3,
			12
		);
		expect(result).toEqual(emptyStats);
	});

	it("fails closed when selection publication metadata is not decoder-compatible", async () => {
		const repository = createPublicLeagueTrendsRepository({
			query: async (sql) => {
				if (sql === PUBLIC_LEAGUE_ACCESS_SQL) {
					return {
						rows: [
							{
								catalog_revision: "2026-08-08T00:00:00.000Z",
								snapshot_revision: "2026-08-08T01:00:00.000Z",
							},
						],
					};
				}
				if (sql === PUBLIC_LEAGUE_SELECTION_SQL) {
					return { rows: [selectionPublicationRow({ expected_entries: "not-a-number" })] };
				}
				throw new Error(`unexpected SQL: ${sql}`);
			},
		});

		expect(await repository.getSelectionStats(context().value, 7, 3, 12)).toBeNull();
	});

	it("does not fall back when the publication query fails", async () => {
		const repository = createPublicLeagueTrendsRepository({
			query: async (sql) => {
				if (sql === PUBLIC_LEAGUE_ACCESS_SQL) {
					return {
						rows: [
							{
								catalog_revision: "2026-08-08T00:00:00.000Z",
								snapshot_revision: "2026-08-08T01:00:00.000Z",
							},
						],
					};
				}
				if (sql === PUBLIC_LEAGUE_SELECTION_SQL) throw new Error("publication unavailable");
				throw new Error(`unexpected SQL: ${sql}`);
			},
		});

		await expect(repository.getSelectionStats(context().value, 7, 3, 12)).rejects.toThrow(
			"publication unavailable"
		);
	});
});
