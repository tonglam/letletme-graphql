import { describe, expect, it } from "bun:test";
import { resolvePlayerStatsContext } from "../../../src/domains/players/season-stats-at-event";
import {
	buildCorePublication,
	buildSnapshotContext,
	buildTestCoreData,
	TestRedis,
} from "../../helpers/data-publication";

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
	core: ReturnType<typeof buildTestCoreData>
) => {
	const timestamp = new Date().toISOString();
	const maxEvent = Math.max(
		0,
		...core.events.filter((event) => event.finished || event.isCurrent).map((event) => event.id)
	);
	const publications = Array.from({ length: maxEvent }, (_, index) => ({
		event_id: index + 1,
		revision: "11",
		source_checked_at: timestamp,
		published_at: timestamp,
		row_count: core.players.length,
		expected_row_count: core.players.length,
		baseline_verified_at: timestamp,
	}));
	const snapshots = Array.from({ length: maxEvent }, (_, index) =>
		core.players.map((player) => ({
			element_id: player.id,
			event_id: index + 1,
			total_points: 0,
		}))
	).flat();
	context.data = {
		read: (table: string) =>
			queryBuilder(
				table === "fpl.player_event_snapshot_publications"
					? publications
					: table === "fpl.player_event_snapshots"
						? snapshots
						: []
			),
	} as never;
};

describe("resolvePlayerStatsContext", () => {
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
});
