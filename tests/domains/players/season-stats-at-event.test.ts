import { describe, expect, it } from "bun:test";
import {
	getPlayerSeasonStatsLoadForContext,
	resolvePlayerStatsContext,
	resolvePlayerStatsFreshnessBudgetMs,
} from "../../../src/domains/players/season-stats-at-event";
import {
	buildCorePublication,
	buildSnapshotContext,
	buildTestCoreData,
	TestRedis,
} from "../../helpers/data-publication";
import { gqlCacheKey } from "../../../src/infra/cache-key";

const queryBuilder = (rows: unknown[]) => {
	let selectedRows = [...rows];
	const builder = {
		select: () => builder,
		eq: (column: string, value: unknown) => {
			selectedRows = selectedRows.filter((row) => {
				const actual = (row as Record<string, unknown>)[column];
				return actual === value || String(actual) === String(value);
			});
			return builder;
		},
		in: (column: string, values: unknown[]) => {
			selectedRows = selectedRows.filter((row) => {
				const actual = (row as Record<string, unknown>)[column];
				return values.some((value) => actual === value || String(actual) === String(value));
			});
			return builder;
		},
		limit: (count: number) => {
			selectedRows = selectedRows.slice(0, count);
			return builder;
		},
		then: <TResult1 = { data: unknown[]; error: null }, TResult2 = never>(
			onfulfilled?:
				((value: { data: unknown[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
			onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
		) => Promise.resolve({ data: selectedRows, error: null }).then(onfulfilled, onrejected),
	};
	return builder;
};

const installPlayerStatsReads = (
	context: ReturnType<typeof buildSnapshotContext>,
	core: ReturnType<typeof buildTestCoreData>,
	sourceCheckedAt = new Date().toISOString()
) => {
	const publishedAt = new Date().toISOString();
	const maxEvent = Math.max(
		0,
		...core.events.filter((event) => event.finished || event.isCurrent).map((event) => event.id)
	);
	const publications = Array.from({ length: maxEvent }, (_, index) => ({
		event_id: index + 1,
		revision: "11",
		source_checked_at: sourceCheckedAt,
		published_at: publishedAt,
		row_count: core.players.length,
		expected_row_count: core.players.length,
		baseline_verified_at: publishedAt,
	}));
	const snapshots = Array.from({ length: maxEvent }, (_, index) =>
		core.players.map((player) => ({
			element_id: player.id,
			event_id: index + 1,
			total_points: 0,
		}))
	).flat();
	const bundles = snapshots.map((snapshot) => ({
		...snapshot,
		publication_revision: "11",
		publication_source_checked_at: sourceCheckedAt,
		publication_published_at: publishedAt,
		publication_row_count: core.players.length,
		publication_expected_row_count: core.players.length,
		publication_content_sha256: "a".repeat(64),
		publication_baseline_verified_at: publishedAt,
	}));
	context.data = {
		read: (table: string) =>
			queryBuilder(
				table === "fpl.player_event_snapshot_bundles"
					? bundles
					: table === "fpl.player_event_snapshot_publications"
						? publications
						: table === "fpl.player_event_snapshots"
							? snapshots
							: []
			),
	} as never;
};

describe("resolvePlayerStatsContext", () => {
	it("uses the dedicated active-event cadence without reading live lifecycle state", () => {
		expect(resolvePlayerStatsFreshnessBudgetMs("ACTIVE_EVENT")).toBe(90_000);
		expect(resolvePlayerStatsFreshnessBudgetMs("STATIC")).toBe(60_000);
	});

	it("defaults unknown observer cadence to the static budget", () => {
		expect(resolvePlayerStatsFreshnessBudgetMs(null)).toBe(60_000);
	});

	it("marks an active observer publication stale without reading live lifecycle state", async () => {
		const now = Date.now();
		const publication = buildCorePublication("2627", 7, buildTestCoreData(3));
		const context = buildSnapshotContext(new TestRedis(publication), {
			databaseQuery: async () => ({
				rows: [
					{
						event_id: 3,
						state: "GW_REVIEW",
						observed_at: new Date(now - 30_000),
						last_changed_at: new Date(now - 60_000),
						next_refresh_at: new Date(now + 30_000),
						live_revision: "7",
						publication_id: "live-7",
						source_checked_at: new Date(now - 120_000),
					},
				],
			}),
		});
		installPlayerStatsReads(context, buildTestCoreData(3), new Date(now - 120_000).toISOString());

		await expect(resolvePlayerStatsContext(context)).resolves.toMatchObject({
			status: "STALE",
			asOfEventId: 3,
			rowCount: 220,
			expectedRowCount: 220,
		});
	});

	it("keeps the same two-minute-old publication stale while matches are live", async () => {
		const now = Date.now();
		const publication = buildCorePublication("2627", 7, buildTestCoreData(3));
		const context = buildSnapshotContext(new TestRedis(publication), {
			databaseQuery: async () => ({
				rows: [
					{
						event_id: 3,
						state: "LIVE_ACTIVE",
						observed_at: new Date(now - 30_000),
						last_changed_at: new Date(now - 60_000),
						next_refresh_at: new Date(now + 30_000),
						live_revision: "7",
						publication_id: "live-7",
						source_checked_at: new Date(now - 120_000),
					},
				],
			}),
		});
		installPlayerStatsReads(context, buildTestCoreData(3), new Date(now - 120_000).toISOString());

		await expect(resolvePlayerStatsContext(context)).resolves.toMatchObject({
			status: "STALE",
			asOfEventId: 3,
		});
	});

	it("uses the request-pinned current event without querying a second authority", async () => {
		const publication = buildCorePublication("2627", 7, buildTestCoreData(3));
		const context = buildSnapshotContext(new TestRedis(publication));
		installPlayerStatsReads(context, buildTestCoreData(3));

		await expect(resolvePlayerStatsContext(context)).resolves.toMatchObject({
			scope: "CURRENT_SEASON",
			season: "2627",
			asOfEventId: 3,
			status: "AVAILABLE",
			revision: "11",
			rowCount: 220,
			expectedRowCount: 220,
		});
		await expect(resolvePlayerStatsContext(context, 1)).resolves.toMatchObject({
			scope: "CURRENT_SEASON",
			season: "2627",
			asOfEventId: 1,
			status: "AVAILABLE",
			revision: "11",
			rowCount: 220,
			expectedRowCount: 220,
		});
	});

	it("keeps pre-season stats unavailable when the publication has no started event", async () => {
		const publication = buildCorePublication("2627", 7, buildTestCoreData(null));
		const context = buildSnapshotContext(new TestRedis(publication));

		await expect(resolvePlayerStatsContext(context)).resolves.toEqual({
			scope: "UNAVAILABLE",
			season: "2627",
			asOfEventId: null,
			status: "UNAVAILABLE",
			revision: null,
			sourceCheckedAt: null,
			publishedAt: null,
			rowCount: 0,
			expectedRowCount: 0,
		});
	});

	it("does not accept a pre-hard-cut available:false cache record as authoritative", async () => {
		const core = buildTestCoreData(3);
		const redis = new TestRedis(buildCorePublication("2627", 7, core));
		const context = buildSnapshotContext(redis);
		installPlayerStatsReads(context, core);
		const key = gqlCacheKey(context, "players:season-stats:9:3:11");
		redis.values.set(
			key,
			JSON.stringify({
				elementId: 9,
				eventId: 3,
				available: false,
				totalPoints: null,
				form: null,
			})
		);

		const load = await getPlayerSeasonStatsLoadForContext(context, [9], {
			scope: "CURRENT_SEASON",
			season: "2627",
			asOfEventId: 3,
			status: "AVAILABLE",
			revision: "11",
			sourceCheckedAt: null,
			publishedAt: null,
			rowCount: 220,
			expectedRowCount: 220,
		});

		expect(load.sourceAvailable).toBe(true);
		expect(load.stats.get(9)?.available).toBe(true);
		expect(load.stats.get(9)?.eventId).toBe(3);
		expect(key).not.toBe(gqlCacheKey(context, "players:season-stats:v2:9:3:11"));
	});
});
