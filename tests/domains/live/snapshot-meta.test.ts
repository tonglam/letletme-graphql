import { describe, expect, it } from "bun:test";
import type { GraphQLContext } from "../../../src/graphql/context";
import {
	isLiveSnapshotDatabaseFallback,
	LiveSnapshotCoherenceError,
	loadLiveSnapshotMeta,
	loadOperationLiveSnapshotMeta,
	parseLiveSnapshotMeta,
	withLiveSnapshotConsistency,
	withLiveSnapshotRoot,
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

	it("keeps every fresh metadata boundary independent", async () => {
		const revision = "0".repeat(24);
		let metadataReads = 0;
		const context = {
			redis: {
				get: async (key: string): Promise<string | null> => {
					if (key === "Season:active") return "2526";
					metadataReads += 1;
					await Promise.resolve();
					return meta(revision);
				},
			},
			logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
		} as unknown as GraphQLContext;

		const concurrent = await Promise.all(
			Array.from({ length: 100 }, () => loadLiveSnapshotMeta(context, 33, { fresh: true }))
		);
		expect(concurrent.every((value) => value?.revision === revision)).toBe(true);
		expect(metadataReads).toBe(100);

		await loadLiveSnapshotMeta(context, 33, { fresh: true });
		expect(metadataReads).toBe(101);
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

	it("uses database mode if publication advances again during the retry", async () => {
		const { context } = contextWithMetaReads([
			meta("5".repeat(24)),
			meta("6".repeat(24), "2025-08-15T20:01:00.000Z"),
			meta("7".repeat(24), "2025-08-15T20:02:00.000Z"),
		]);
		let runs = 0;
		const result = await withLiveSnapshotConsistency(context, 33, async () => {
			runs += 1;
			return isLiveSnapshotDatabaseFallback(context, 33) ? "database" : "redis";
		});

		expect(result).toBe("database");
		expect(runs).toBe(3);
		expect(await loadOperationLiveSnapshotMeta(context, 33)).toBeNull();
	});

	it("uses database mode when previously available metadata disappears", async () => {
		const { context } = contextWithMetaReads([meta("8".repeat(24)), null]);
		let runs = 0;
		const result = await withLiveSnapshotConsistency(context, 33, async () => {
			runs += 1;
			return isLiveSnapshotDatabaseFallback(context, 33) ? "database" : "redis";
		});

		expect(result).toBe("database");
		expect(runs).toBe(2);
		expect(await loadOperationLiveSnapshotMeta(context, 33)).toBeNull();
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

	it("waits for sibling live work and returns its final operation revision", async () => {
		const firstRevision = "f".repeat(24);
		const secondRevision = "1".repeat(24);
		const { context } = contextWithMetaReads([
			meta(firstRevision),
			meta(secondRevision, "2025-08-15T20:01:00.000Z"),
			meta(secondRevision, "2025-08-15T20:01:00.000Z"),
		]);
		let releaseFirstRun!: () => void;
		const firstRunBlocked = new Promise<void>((resolve) => {
			releaseFirstRun = resolve;
		});
		let runs = 0;
		const liveResult = withLiveSnapshotConsistency(context, 33, async () => {
			runs += 1;
			if (runs === 1) await firstRunBlocked;
			return runs;
		});
		const operationMeta = loadOperationLiveSnapshotMeta(context, 33);

		releaseFirstRun();

		expect(await liveResult).toBe(2);
		expect((await operationMeta)?.revision).toBe(secondRevision);
	});

	it("waits while a sibling root resolver discovers its current event", async () => {
		const revision = "4".repeat(24);
		const { context } = contextWithMetaReads([meta(revision), meta(revision)]);
		let releaseEventDiscovery!: () => void;
		const eventDiscoveryBlocked = new Promise<void>((resolve) => {
			releaseEventDiscovery = resolve;
		});
		let announceEventDiscovery!: () => void;
		const eventDiscoveryStarted = new Promise<void>((resolve) => {
			announceEventDiscovery = resolve;
		});

		const liveResult = withLiveSnapshotRoot(context, async () => {
			announceEventDiscovery();
			await eventDiscoveryBlocked;
			return withLiveSnapshotConsistency(context, 33, async () => "live-data");
		});
		await eventDiscoveryStarted;
		const operationMeta = loadOperationLiveSnapshotMeta(context, 33);

		releaseEventDiscovery();

		expect(await liveResult).toBe("live-data");
		expect((await operationMeta)?.revision).toBe(revision);
	});

	it("retries every coordinated source in database mode after one view is invalid", async () => {
		const { context } = contextWithMetaReads([meta("2".repeat(24))]);
		let runs = 0;
		const result = await withLiveSnapshotConsistency(context, 33, async () => {
			runs += 1;
			if (runs === 1) {
				throw new LiveSnapshotCoherenceError(33, "Fixtures", "incomplete fixtures");
			}
			expect(isLiveSnapshotDatabaseFallback(context, 33)).toBe(true);
			return "database";
		});

		expect(result).toBe("database");
		expect(runs).toBe(2);
		expect(await loadOperationLiveSnapshotMeta(context, 33)).toBeNull();
	});

	it("discards a concurrent Redis result when a sibling selects database mode", async () => {
		const { context } = contextWithMetaReads([meta("3".repeat(24))]);
		let releaseRedisRun!: () => void;
		const redisRunBlocked = new Promise<void>((resolve) => {
			releaseRedisRun = resolve;
		});
		let announceRedisRun!: () => void;
		const redisRunStarted = new Promise<void>((resolve) => {
			announceRedisRun = resolve;
		});
		let firstReaderRuns = 0;
		const firstReader = withLiveSnapshotConsistency(context, 33, async () => {
			firstReaderRuns += 1;
			if (firstReaderRuns === 1) {
				announceRedisRun();
				await redisRunBlocked;
				return "redis";
			}
			return "database";
		});
		await redisRunStarted;

		let siblingRuns = 0;
		const sibling = withLiveSnapshotConsistency(context, 33, async () => {
			siblingRuns += 1;
			if (siblingRuns === 1) {
				throw new LiveSnapshotCoherenceError(33, "Fixtures", "incomplete fixtures");
			}
			return "database";
		});
		expect(await sibling).toBe("database");
		releaseRedisRun();

		expect(await firstReader).toBe("database");
		expect(firstReaderRuns).toBe(2);
	});

	it("holds a completed root until a slower sibling chooses database mode", async () => {
		const { context } = contextWithMetaReads([meta("9".repeat(24))]);
		let fastRuns = 0;
		let fastResolved = false;
		const fastRoot = withLiveSnapshotRoot(context, () =>
			withLiveSnapshotConsistency(context, 33, async () => {
				fastRuns += 1;
				return isLiveSnapshotDatabaseFallback(context, 33) ? "database" : "redis";
			})
		);
		void fastRoot.then(() => {
			fastResolved = true;
		});

		let releaseSlowRoot!: () => void;
		const slowRootBlocked = new Promise<void>((resolve) => {
			releaseSlowRoot = resolve;
		});
		let announceSlowRoot!: () => void;
		const slowRootStarted = new Promise<void>((resolve) => {
			announceSlowRoot = resolve;
		});
		let slowRuns = 0;
		const slowRoot = withLiveSnapshotRoot(context, () =>
			withLiveSnapshotConsistency(context, 33, async () => {
				slowRuns += 1;
				if (slowRuns === 1) {
					announceSlowRoot();
					await slowRootBlocked;
					throw new LiveSnapshotCoherenceError(33, "Fixtures", "incomplete fixtures");
				}
				return "database";
			})
		);

		await slowRootStarted;
		await Promise.resolve();
		expect(fastResolved).toBe(false);
		releaseSlowRoot();

		expect(await fastRoot).toBe("database");
		expect(await slowRoot).toBe("database");
		expect(fastRuns).toBe(2);
		expect(slowRuns).toBe(2);
		expect(await loadOperationLiveSnapshotMeta(context, 33)).toBeNull();
	});

	it("does not reuse an earlier sibling final poll after later view reads", async () => {
		const firstRevision = meta("a".repeat(24));
		const secondRevision = meta("b".repeat(24), "2025-08-15T20:01:00.000Z");
		let metadataReads = 0;
		let announceStaleFinalPoll!: () => void;
		const staleFinalPollStarted = new Promise<void>((resolve) => {
			announceStaleFinalPoll = resolve;
		});
		let releaseStaleFinalPoll!: () => void;
		const staleFinalPollBlocked = new Promise<void>((resolve) => {
			releaseStaleFinalPoll = resolve;
		});
		let announceLaterFinalPoll!: () => void;
		const laterFinalPollStarted = new Promise<void>((resolve) => {
			announceLaterFinalPoll = resolve;
		});
		const context = {
			redis: {
				get: async (key: string): Promise<string | null> => {
					if (key === "Season:active") return "2526";
					metadataReads += 1;
					if (metadataReads <= 2) return firstRevision;
					if (metadataReads === 3) {
						announceStaleFinalPoll();
						await staleFinalPollBlocked;
						return firstRevision;
					}
					announceLaterFinalPoll();
					return secondRevision;
				},
			},
			logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
		} as unknown as GraphQLContext;

		let fastRuns = 0;
		let slowRuns = 0;
		const fastRoot = withLiveSnapshotRoot(context, () =>
			withLiveSnapshotConsistency(context, 33, async () => {
				fastRuns += 1;
				return isLiveSnapshotDatabaseFallback(context, 33) ? "database" : "redis-r1";
			})
		);
		const slowRoot = withLiveSnapshotRoot(context, () =>
			withLiveSnapshotConsistency(context, 33, async () => {
				slowRuns += 1;
				if (slowRuns === 1) await staleFinalPollStarted;
				return isLiveSnapshotDatabaseFallback(context, 33) ? "database" : "redis-r2";
			})
		);

		await laterFinalPollStarted;
		releaseStaleFinalPoll();

		expect(await fastRoot).toBe("database");
		expect(await slowRoot).toBe("database");
		expect(fastRuns).toBe(2);
		// The slow reader first retries its own R1 -> R2 advance, then joins the
		// operation-wide database fallback when the sibling candidates differ.
		expect(slowRuns).toBe(3);
		expect(metadataReads).toBe(5);
		expect(await loadOperationLiveSnapshotMeta(context, 33)).toBeNull();
	});

	it("degrades sibling roots that finish on different stable revisions", async () => {
		const firstRevision = meta("a".repeat(24));
		const secondRevision = meta("b".repeat(24), "2025-08-15T20:01:00.000Z");
		let metadataReads = 0;
		let announceFirstRevisionComplete!: () => void;
		const firstRevisionComplete = new Promise<void>((resolve) => {
			announceFirstRevisionComplete = resolve;
		});
		const context = {
			redis: {
				get: async (key: string): Promise<string | null> => {
					if (key === "Season:active") return "2526";
					metadataReads += 1;
					if (metadataReads === 2) announceFirstRevisionComplete();
					return metadataReads <= 2 ? firstRevision : secondRevision;
				},
			},
			logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
		} as unknown as GraphQLContext;
		let releaseSecondRoot!: () => void;
		const secondRootBlocked = new Promise<void>((resolve) => {
			releaseSecondRoot = resolve;
		});
		let firstRuns = 0;
		let secondRuns = 0;
		const firstRoot = withLiveSnapshotRoot(context, () =>
			withLiveSnapshotConsistency(context, 33, async () => {
				firstRuns += 1;
				return isLiveSnapshotDatabaseFallback(context, 33) ? "database" : "redis-a";
			})
		);
		const secondRoot = withLiveSnapshotRoot(context, async () => {
			await secondRootBlocked;
			return withLiveSnapshotConsistency(context, 33, async () => {
				secondRuns += 1;
				return isLiveSnapshotDatabaseFallback(context, 33) ? "database" : "redis-b";
			});
		});

		await firstRevisionComplete;
		await Promise.resolve();
		releaseSecondRoot();

		expect(await firstRoot).toBe("database");
		expect(await secondRoot).toBe("database");
		expect(firstRuns).toBe(2);
		expect(secondRuns).toBe(2);
		expect(await loadOperationLiveSnapshotMeta(context, 33)).toBeNull();
	});

	it("keeps a nested event read from releasing the enclosing root barrier", async () => {
		const currentMeta = meta("a".repeat(24));
		const nextMeta = meta("b".repeat(24)).replace('"eventId":33', '"eventId":34');
		const context = {
			redis: {
				get: async (key: string): Promise<string | null> => {
					if (key === "Season:active") return "2526";
					if (key === "LiveSnapshotMeta:2526:33") return currentMeta;
					if (key === "LiveSnapshotMeta:2526:34") return nextMeta;
					return null;
				},
			},
			logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
		} as unknown as GraphQLContext;
		let releaseOuter!: () => void;
		const outerBlocked = new Promise<void>((resolve) => {
			releaseOuter = resolve;
		});
		let nestedFinished!: () => void;
		const nestedComplete = new Promise<void>((resolve) => {
			nestedFinished = resolve;
		});
		let siblingReturned = false;

		const outer = withLiveSnapshotRoot(context, () =>
			withLiveSnapshotConsistency(context, 33, async () => {
				const next = await withLiveSnapshotConsistency(context, 34, async () => "next", {
					participateInRootBarrier: false,
				});
				nestedFinished();
				await outerBlocked;
				return next;
			})
		);
		const sibling = withLiveSnapshotRoot(context, () =>
			withLiveSnapshotConsistency(context, 33, async () => "sibling").then((value) => {
				siblingReturned = true;
				return value;
			})
		);

		await nestedComplete;
		await Promise.resolve();
		expect(siblingReturned).toBe(false);
		releaseOuter();

		expect(await outer).toBe("next");
		expect(await sibling).toBe("sibling");
	});
});
