import { describe, expect, it } from "bun:test";
import type { GraphQLContext } from "../../../src/graphql/context";
import {
	loadLiveSnapshotMeta,
	parseLiveSnapshotMeta,
	withLiveSnapshotConsistency,
} from "../../../src/domains/live/snapshot-meta";

const meta = (revision: string, checkedAt = "2025-08-15T20:00:00.000Z") =>
	JSON.stringify({
		schemaVersion: 1,
		season: "2526",
		eventId: 33,
		revision,
		state: "live",
		publishedAt: "2025-08-15T19:59:00.000Z",
		checkedAt,
		eventLiveCount: 700,
		fixtureCount: 10,
		fixtureTeamCount: 20,
		bonusTeamCount: 4,
	});

const contextWithMetaReads = (reads: Array<string | null>) => {
	let index = 0;
	const messages: string[] = [];
	const context = {
		redis: {
			get: async (key: string): Promise<string | null> => {
				if (key === "Season:active") return "2526";
				return reads[Math.min(index++, reads.length - 1)] ?? null;
			},
		},
		logger: {
			info: (_data: unknown, message: string) => messages.push(message),
			warn: (_data: unknown, message: string) => messages.push(message),
			error: () => undefined,
		},
	} as unknown as GraphQLContext;
	return { context, messages };
};

describe("live snapshot metadata", () => {
	it("validates scope, revision, timestamps, state, and completeness counts", () => {
		const revision = "a".repeat(24);
		expect(parseLiveSnapshotMeta(meta(revision), { season: "2526", eventId: 33 })).toMatchObject({
			revision,
			state: "live",
			eventLiveCount: 700,
		});
		expect(parseLiveSnapshotMeta(meta(revision), { eventId: 34 })).toBeNull();
		expect(
			parseLiveSnapshotMeta(meta(revision).replace('"fixtureCount":10', '"fixtureCount":0'))
		).toBeNull();
		expect(parseLiveSnapshotMeta("not-json")).toBeNull();
	});

	it("memoizes ordinary reads within one GraphQL request", async () => {
		const revision = "b".repeat(24);
		const { context } = contextWithMetaReads([meta(revision)]);
		const first = await loadLiveSnapshotMeta(context, 33);
		const second = await loadLiveSnapshotMeta(context, 33);
		expect(first?.revision).toBe(revision);
		expect(second).toBe(first);
	});

	it("retries a calculation once when publication advances between reads", async () => {
		const firstRevision = "c".repeat(24);
		const secondRevision = "d".repeat(24);
		const { context, messages } = contextWithMetaReads([
			meta(firstRevision),
			meta(secondRevision, "2025-08-15T20:01:00.000Z"),
			meta(secondRevision, "2025-08-15T20:01:00.000Z"),
		]);
		let runs = 0;
		const result = await withLiveSnapshotConsistency(context, 33, async () => {
			runs += 1;
			return runs;
		});

		expect(result).toBe(2);
		expect(runs).toBe(2);
		expect(messages).toContain("Live snapshot advanced during request; retrying once");
	});

	it("runs once when metadata is stable or not deployed yet", async () => {
		for (const reads of [
			[meta("e".repeat(24)), meta("e".repeat(24))],
			[null, null],
		]) {
			const { context } = contextWithMetaReads(reads);
			let runs = 0;
			await withLiveSnapshotConsistency(context, 33, async () => {
				runs += 1;
			});
			expect(runs).toBe(1);
		}
	});
});
