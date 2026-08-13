import { describe, expect, it } from "bun:test";
import { eventOverallResultRepository } from "../../../src/domains/event-overall-result/repository";
import {
	buildCorePublication,
	buildSnapshotContext,
	buildTestCoreData,
	TestRedis,
} from "../../helpers/data-publication";

describe("eventOverallResultRepository", () => {
	it("derives every event result from the request-pinned core publication", async () => {
		const baseline = buildTestCoreData(1);
		const core = buildTestCoreData(1, {
			events: baseline.events.map((event) =>
				event.id === 1
					? {
							...event,
							averageEntryScore: 61,
							finished: true,
							highestScoringEntry: 123,
							highestScore: 111,
							chipPlays: [{ chipName: "bboost", numberPlayed: 45 }],
							mostSelected: 1,
							mostTransferredIn: 2,
							topElement: 3,
							topElementInfo: { element: 3, points: 16 },
							transfersMade: 999,
							mostCaptained: 4,
							mostViceCaptained: 5,
						}
					: event
			),
		});
		const redis = new TestRedis(buildCorePublication("2627", 17, core));
		redis.hashes.set("EventOverallResult:2627", new Map([["1", "not canonical"]]));
		let oldHashReads = 0;
		const originalHgetall = redis.hgetall;
		redis.hgetall = async (key: string) => {
			if (key.startsWith("EventOverallResult:")) oldHashReads += 1;
			return originalHgetall(key);
		};
		const context = buildSnapshotContext(redis, { dataRevision: "core-17" });

		const results = await eventOverallResultRepository.getEventOverallResult(context);

		expect(results).toHaveLength(38);
		expect(results[0]).toMatchObject({
			event: 1,
			averageScore: 61,
			finished: true,
			highestScoringEntry: 123,
			highestScore: 111,
			chipPlays: [{ chipName: "bboost", numberPlayed: 45 }],
			mostSelectedId: 1,
			mostTransferredInId: 2,
			topElementInfo: { element: 3, points: 16 },
			transfersMade: 999,
			mostCaptainedId: 4,
			mostViceCaptainedId: 5,
		});
		expect(oldHashReads).toBe(0);
	});

	it("filters to one event when an event id is provided", async () => {
		const redis = new TestRedis(buildCorePublication("2627", 17, buildTestCoreData(1)));
		const context = buildSnapshotContext(redis, { dataRevision: "core-17" });

		const results = await eventOverallResultRepository.getEventOverallResult(context, 2);

		expect(results).toHaveLength(1);
		expect(results[0]?.event).toBe(2);
	});
});
