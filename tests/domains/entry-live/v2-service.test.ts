import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { graphql } from "graphql";
import { schema } from "../../../src/graphql/schema";
import {
	calcLivePointsForEntriesV2,
	calcLivePointsByEntryV2,
	clearLivePointsV2Lkg,
	loadLiveSnapshotMetaV2,
} from "../../../src/domains/entry-live/v2-service";
import {
	buildCorePublication,
	buildSnapshotContext,
	buildTestCoreData,
	buildTestEventLives,
	TestRedis,
	toPublicationFixture,
} from "../../helpers/data-publication";

const canonicalize = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value as Record<string, unknown>)
				.sort()
				.map((key) => [key, canonicalize((value as Record<string, unknown>)[key])])
		);
	}
	return value;
};

const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value));
const hash = (value: unknown): string =>
	createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");

const publicationId = (suffix: string): string =>
	`00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;

const buildV2Redis = (
	options: {
		sourceCheckedAt?: string;
		entrySourceCheckedAt?: string;
		previous?: boolean;
	} = {}
) => {
	const core = buildTestCoreData(1, {
		fixtures: buildTestCoreData(1).fixtures.map((fixture, index) =>
			fixture.eventId === 1 && index === 0 ? { ...fixture, started: true, minutes: 45 } : fixture
		),
	});
	const eventLives = buildTestEventLives(core, 1).map((row, index) =>
		index === 2 ? { ...row, minutes: 90, starts: true, totalPoints: 8 } : row
	);
	const fixtures = core.fixtures
		.filter((fixture) => fixture.eventId === 1)
		.map(toPublicationFixture);
	const sourceCheckedAt = options.sourceCheckedAt ?? new Date().toISOString();
	const entrySourceCheckedAt = options.entrySourceCheckedAt ?? sourceCheckedAt;
	const revisions = {
		lifecycle: { revision: hash({ lifecycle: "LIVE_ACTIVE" }), contentUpdatedAt: sourceCheckedAt },
		fixtureIdentity: { revision: hash(fixtures), contentUpdatedAt: sourceCheckedAt },
		scoreCore: {
			revision: hash(
				eventLives.map((row) => ({
					eventId: row.eventId,
					elementId: row.elementId,
					minutes: row.minutes,
					starts: row.starts,
					totalPoints: row.totalPoints,
				}))
			),
			contentUpdatedAt: sourceCheckedAt,
		},
		displayStats: { revision: hash(eventLives), contentUpdatedAt: sourceCheckedAt },
		explain: {
			revision: hash(eventLives.map((row) => ({ elementId: row.elementId, fixtureBreakdown: [] }))),
			contentUpdatedAt: sourceCheckedAt,
		},
		rules: {
			revision: hash({ rules: "live-points-v2-rules-1" }),
			contentUpdatedAt: sourceCheckedAt,
		},
	};
	const redis = new TestRedis(buildCorePublication("2627", 7, core));
	const addGlobal = (generation: number, id: string): string => {
		const eventLiveKey = `llm:data:v2:fpl:live:2627:1:${generation}:eventLive`;
		const fixtureKey = `llm:data:v2:fpl:live:2627:1:${generation}:fixtures`;
		const eventLivePayload = canonicalJson(eventLives);
		const fixturePayload = canonicalJson(fixtures);
		redis.values.set(eventLiveKey, eventLivePayload);
		redis.values.set(fixtureKey, fixturePayload);
		redis.values.set(
			`${eventLiveKey}:meta`,
			`${eventLives.length}|${Buffer.byteLength(eventLivePayload)}|${hash(eventLives)}`
		);
		redis.values.set(
			`${fixtureKey}:meta`,
			`${fixtures.length}|${Buffer.byteLength(fixturePayload)}|${hash(fixtures)}`
		);
		redis.values.set(
			`llm:data:v2:fpl:live:2627:1:${options.previous ? "previous" : "active"}`,
			JSON.stringify({
				contractVersion: "live-points-v2",
				publicationId: publicationId(id),
				generation,
				season: "2627",
				eventId: 1,
				state: "LIVE_ACTIVE",
				sourceCheckedAt,
				publishedAt: sourceCheckedAt,
				checkpointedAt: null,
				expectedNextCheckAt: null,
				revisions,
				items: {
					eventLive: {
						name: "eventLive",
						key: eventLiveKey,
						type: "string",
						count: eventLives.length,
						bytes: Buffer.byteLength(eventLivePayload),
						sha256: hash(eventLives),
					},
					fixtures: {
						name: "fixtures",
						key: fixtureKey,
						type: "string",
						count: fixtures.length,
						bytes: Buffer.byteLength(fixturePayload),
						sha256: hash(fixtures),
					},
				},
			})
		);
		return id;
	};

	const picks = [
		{ element: 1, position: 1, multiplier: 1, isCaptain: false, isViceCaptain: false },
		{ element: 2, position: 2, multiplier: 1, isCaptain: false, isViceCaptain: false },
		{ element: 6, position: 3, multiplier: 1, isCaptain: false, isViceCaptain: false },
		{ element: 10, position: 4, multiplier: 1, isCaptain: false, isViceCaptain: false },
		{ element: 3, position: 5, multiplier: 1, isCaptain: true, isViceCaptain: false },
		{ element: 7, position: 6, multiplier: 1, isCaptain: false, isViceCaptain: true },
		{ element: 11, position: 7, multiplier: 1, isCaptain: false, isViceCaptain: false },
		{ element: 15, position: 8, multiplier: 1, isCaptain: false, isViceCaptain: false },
		{ element: 19, position: 9, multiplier: 1, isCaptain: false, isViceCaptain: false },
		{ element: 4, position: 10, multiplier: 1, isCaptain: false, isViceCaptain: false },
		{ element: 8, position: 11, multiplier: 1, isCaptain: false, isViceCaptain: false },
		{ element: 12, position: 12, multiplier: 1, isCaptain: false, isViceCaptain: false },
		{ element: 16, position: 13, multiplier: 1, isCaptain: false, isViceCaptain: false },
		{ element: 20, position: 14, multiplier: 1, isCaptain: false, isViceCaptain: false },
		{ element: 24, position: 15, multiplier: 1, isCaptain: false, isViceCaptain: false },
	] as const;
	const input = {
		contractVersion: "live-points-v2",
		season: "2627",
		eventId: 1,
		entryId: 6953,
		picksBase: {
			revision: hash({ picks, chip: null, transferCost: 4 }),
			contentUpdatedAt: entrySourceCheckedAt,
			picks,
			chip: null,
			transferCost: 4,
		},
		previousTotals: null,
		officialAdjustment: null,
		finalResult: null,
	};
	const inputPayload = canonicalJson(input);
	const inputKey = "llm:data:v2:fpl:entry-live:2627:1:6953:1:input";
	redis.values.set(inputKey, inputPayload);
	redis.values.set(`${inputKey}:meta`, `15|${Buffer.byteLength(inputPayload)}|${hash(input)}`);
	redis.values.set(
		"llm:data:v2:fpl:entry-live:2627:1:6953:active",
		JSON.stringify({
			contractVersion: "live-points-v2",
			publicationId: publicationId("6953"),
			generation: 1,
			season: "2627",
			eventId: 1,
			entryId: 6953,
			state: "PROVISIONAL",
			sourceCheckedAt: entrySourceCheckedAt,
			publishedAt: sourceCheckedAt,
			checkpointedAt: null,
			expectedNextCheckAt: null,
			item: {
				name: "input",
				key: inputKey,
				type: "string",
				count: 15,
				bytes: Buffer.byteLength(inputPayload),
				sha256: hash(input),
			},
		})
	);
	addGlobal(1, "1");
	return redis;
};

describe("Live Points V2 projection", () => {
	it("returns one complete same-event 15-pick projection without a Data/FPL request", async () => {
		clearLivePointsV2Lkg();
		const context = buildSnapshotContext(buildV2Redis());
		const result = await calcLivePointsByEntryV2(context, 1, 6953);
		expect(result.availability).toBe("READY");
		expect(result.pickList).toHaveLength(15);
		expect(new Set(result.pickList.map((pick) => pick.element)).size).toBe(15);
		expect(result.score.netEventPoints).toBe(result.score.eventPoints - 4);
		expect(result.score.totalPoints).toBeNull();
		expect(result.score.revisions.input).not.toBe("unavailable");
	});

	it("does not apply the 30-second live heartbeat budget to immutable picks", async () => {
		clearLivePointsV2Lkg();
		const redis = buildV2Redis({
			sourceCheckedAt: new Date().toISOString(),
			entrySourceCheckedAt: "2026-08-01T00:00:00.000Z",
		});
		const result = await calcLivePointsByEntryV2(buildSnapshotContext(redis), 1, 6953);
		expect(result.availability).toBe("READY");
		expect(result.delivery.state).toBe("FRESH");
		expect(result.score.times.sourceCheckedAt).toBe(result.snapshot.times.sourceCheckedAt);
	});

	it("falls back from a corrupt current pointer to the previous complete publication", async () => {
		const redis = buildV2Redis({ previous: true });
		redis.values.set("llm:data:v2:fpl:live:2627:1:active", "not-json");
		const meta = await loadLiveSnapshotMetaV2(buildSnapshotContext(redis), 1);
		expect(meta?.delivery.servedFrom).toBe("REDIS_PREVIOUS");
		expect(meta?.delivery.state).toBe("DEGRADED");
	});

	it("fails closed when a payload metadata tuple is tampered", async () => {
		clearLivePointsV2Lkg();
		const redis = buildV2Redis();
		redis.values.set(
			"llm:data:v2:fpl:live:2627:1:1:eventLive:meta",
			"0|0|0000000000000000000000000000000000000000000000000000000000000000"
		);
		const result = await calcLivePointsByEntryV2(buildSnapshotContext(redis), 1, 6953);
		expect(result.availability).toBe("UNAVAILABLE");
		expect(result.pickList).toHaveLength(0);
	});

	it("rejects a checksum-valid event-live payload with an incomplete player roster", async () => {
		clearLivePointsV2Lkg();
		const redis = buildV2Redis();
		const itemKey = "llm:data:v2:fpl:live:2627:1:1:eventLive";
		const activeKey = "llm:data:v2:fpl:live:2627:1:active";
		const truncated = (JSON.parse(redis.values.get(itemKey)!) as unknown[]).slice(1);
		const payload = canonicalJson(truncated);
		const checksum = hash(truncated);
		redis.values.set(itemKey, payload);
		redis.values.set(
			`${itemKey}:meta`,
			`${truncated.length}|${Buffer.byteLength(payload)}|${checksum}`
		);
		const manifest = JSON.parse(redis.values.get(activeKey)!) as {
			items: { eventLive: { count: number; bytes: number; sha256: string } };
		};
		manifest.items.eventLive = {
			count: truncated.length,
			bytes: Buffer.byteLength(payload),
			sha256: checksum,
		};
		redis.values.set(activeKey, JSON.stringify(manifest));

		const result = await calcLivePointsByEntryV2(buildSnapshotContext(redis), 1, 6953);
		expect(result.availability).toBe("UNAVAILABLE");
		expect(result.delivery.state).toBe("UNAVAILABLE");
		expect(result.pickList).toHaveLength(0);
	});

	it("keeps the exact same-event projection in process LKG while Redis and PostgreSQL are down", async () => {
		clearLivePointsV2Lkg();
		const firstContext = buildSnapshotContext(buildV2Redis());
		const first = await calcLivePointsByEntryV2(firstContext, 1, 6953);
		const unavailableRedis = {
			get: async () => {
				throw new Error("redis down");
			},
			mget: async () => {
				throw new Error("redis down");
			},
		} as never;
		const context = buildSnapshotContext(unavailableRedis, {
			databaseQuery: async () => {
				throw new Error("postgres down");
			},
		});
		const result = await calcLivePointsByEntryV2(context, 1, 6953);
		expect(result.availability).toBe("READY");
		expect(result.delivery.state).toBe("DEGRADED");
		expect(result.delivery.servedFrom).toBe("PROCESS_LKG");
		expect(result.entry).toBe(first.entry);
		expect(result.event).toBe(first.event);
		expect(result.pickList).toHaveLength(15);
	});

	it("keeps a complete same-event projection renderable when player metadata is down", async () => {
		clearLivePointsV2Lkg();
		const redis = buildV2Redis();
		const warm = await calcLivePointsByEntryV2(buildSnapshotContext(redis), 1, 6953);
		expect(warm.availability).toBe("READY");
		for (const key of [...redis.values.keys()]) {
			if (key.startsWith("llm:data:fpl:core:2627:")) redis.values.delete(key);
		}
		const result = await calcLivePointsByEntryV2(
			buildSnapshotContext(redis, {
				databaseQuery: async () => {
					throw new Error("postgres down");
				},
			}),
			1,
			6953
		);
		expect(result.availability).toBe("READY");
		expect(result.delivery.state).toBe("DEGRADED");
		expect(result.delivery.reasonCodes).toContain("CORE_IDENTITY_UNAVAILABLE");
		expect(result.pickList).toHaveLength(15);
	});

	it("probes Redis entry input before using a warmed process LKG", async () => {
		clearLivePointsV2Lkg();
		const redis = buildV2Redis();
		const entryPointerReads: string[] = [];
		const originalGet = redis.get;
		redis.get = async (key: string) => {
			if (key.includes(":entry-live:")) entryPointerReads.push(key);
			return originalGet(key);
		};
		await calcLivePointsByEntryV2(buildSnapshotContext(redis), 1, 6953);
		entryPointerReads.length = 0;

		const result = await calcLivePointsForEntriesV2(buildSnapshotContext(redis), 1, [6953]);
		expect(result.results.get(6953)?.availability).toBe("READY");
		expect(entryPointerReads).toContain("llm:data:v2:fpl:entry-live:2627:1:6953:active");
	});

	it("does not turn an input miss into NO_PICKS", async () => {
		clearLivePointsV2Lkg();
		const redis = buildV2Redis();
		redis.values.delete("llm:data:v2:fpl:entry-live:2627:1:6953:active");
		const result = await graphql({
			schema,
			source: `query { calcLivePointsByEntry(eventId: 1, entryId: 6953) { availability delivery { state } pickList { element } } }`,
			contextValue: buildSnapshotContext(redis),
		});
		expect(result.errors).toBeUndefined();
		expect(result.data?.calcLivePointsByEntry).toEqual({
			availability: "PENDING",
			delivery: { state: "UNAVAILABLE" },
			pickList: [],
		});
	});

	it("batches PostgreSQL entry checkpoint fallbacks", async () => {
		clearLivePointsV2Lkg();
		const redis = buildV2Redis();
		redis.values.delete("llm:data:v2:fpl:entry-live:2627:1:6953:active");
		const databaseCalls: Array<{ sql: string; values: unknown[] }> = [];
		const context = buildSnapshotContext(redis, {
			databaseQuery: async (sql, values) => {
				databaseCalls.push({ sql: String(sql), values: values as unknown[] });
				return { rows: [] };
			},
		});
		const result = await calcLivePointsForEntriesV2(context, 1, [6953]);
		expect(result.results.size).toBe(1);
		expect(result.meta).toEqual({
			eventId: 1,
			totalEntries: 1,
			succeededCount: 1,
			failedCount: 0,
		});
		const checkpointCalls = databaseCalls.filter((call) => call.sql.includes("ANY($2::integer[])"));
		expect(checkpointCalls).toHaveLength(1);
		expect(checkpointCalls[0]?.values[1]).toEqual([6953]);
	});
});
