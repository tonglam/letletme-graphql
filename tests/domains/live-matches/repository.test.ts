import { beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { graphql } from "graphql";

import { schema } from "../../../src/graphql/schema";
import {
	LIVE_MATCHES_READ_BUNDLE_LUA,
	LIVE_MATCH_MAX_FIXTURES,
	readLiveMatchday,
	resetLiveMatchProcessStateForTests,
} from "../../../src/domains/live-matches/repository";
import { buildSnapshotContext, TestRedis } from "../../helpers/data-publication";

const now = "2026-08-31T10:00:00.000Z";
const later = "2026-08-31T10:01:00.000Z";

const canonical = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value as Record<string, unknown>)
				.sort()
				.map((key) => [key, canonical((value as Record<string, unknown>)[key])])
		);
	}
	return value;
};

const encode = (value: unknown): string => JSON.stringify(canonical(value));
const digest = (value: unknown): string =>
	createHash("sha256").update(encode(value), "utf8").digest("hex");
const itemMeta = (value: unknown): string =>
	`${Array.isArray(value) ? value.length : 0}|${Buffer.byteLength(encode(value), "utf8")}|${digest(value)}`;

const emptyDesk = { publication: null, payload: null, metadata: null };
const emptyDetail = { publication: null, manifest: null, items: [] };

const fixture = (fixtureId: number, awayTeamId: number, started = true) => ({
	fixtureId,
	eventId: 1,
	homeTeamId: 1,
	homeTeamName: "Home",
	homeTeamShortName: "HOM",
	awayTeamId,
	awayTeamName: `Away ${awayTeamId}`,
	awayTeamShortName: `A${awayTeamId}`,
	homeScore: started ? 1 : null,
	awayScore: started ? 0 : null,
	kickoffTime: now,
	minutes: started ? 45 : 0,
	started,
	finished: false,
	finishedProvisional: false,
});

const player = (totalPoints: number) => ({
	id: 9001,
	webName: "DGW Player",
	position: 3,
	teamId: 1,
	totalPoints,
	stats: [
		{ identifier: "bps", value: totalPoints * 10, points: totalPoints, pointsModification: null },
	],
});

const publicationId = (generation: number): string =>
	`00000000-0000-4000-8000-${String(generation).padStart(12, "0")}`;

const buildBundle = (
	options: {
		deskGeneration?: number;
		deskState?: "LIVE_ACTIVE" | "FINALIZED";
		detailDeskGeneration?: number;
		detailItemGeneration?: number;
		corruptDesk?: boolean;
		checkpointed?: boolean;
		omitDetail?: boolean;
		detailFinalized?: boolean;
		deskStarted?: boolean;
	} = {}
) => {
	const deskGeneration = options.deskGeneration ?? 2;
	const deskState = options.deskState ?? "LIVE_ACTIVE";
	const checkpointedAt = options.checkpointed ? later : null;
	const detailDeskGeneration = options.detailDeskGeneration ?? deskGeneration;
	const deskFixtures = [
		fixture(101, 2, options.deskStarted ?? true),
		fixture(102, 3, options.deskStarted ?? true),
	];
	const deskPayload = encode(deskFixtures);
	const fixtureIdentityRevision = digest(
		deskFixtures.map(({ fixtureId, homeTeamId, awayTeamId }) => ({
			fixtureId,
			homeTeamId,
			awayTeamId,
		}))
	);
	const revisions = {
		lifecycle: { revision: digest({ state: "LIVE_ACTIVE" }), contentUpdatedAt: now },
		fixtureIdentity: { revision: fixtureIdentityRevision, contentUpdatedAt: now },
		scoreState: {
			revision: digest(
				deskFixtures.map(({ fixtureId, homeScore, awayScore, minutes }) => ({
					fixtureId,
					homeScore,
					awayScore,
					minutes,
				}))
			),
			contentUpdatedAt: later,
		},
	};
	const deskPublication = {
		contractVersion: "live-matches-v2",
		publicationId: publicationId(deskGeneration),
		generation: deskGeneration,
		season: "2627",
		eventId: 1,
		state: deskState,
		sourceCheckedAt: later,
		publishedAt: later,
		checkpointedAt,
		expectedNextCheckAt: "2026-08-31T10:01:30.000Z",
		staleAt: "2026-08-31T10:02:15.000Z",
		revisions,
		desk: {
			name: "desk",
			key: `llm:data:v2:fpl:live-match:desk:2627:1:${deskGeneration}:desk`,
			type: "string",
			count: deskFixtures.length,
			bytes: Buffer.byteLength(deskPayload, "utf8"),
			sha256: digest(deskFixtures),
		},
	};

	const detailFixtures = [
		{ fixtureId: 101, players: [player(3)] },
		{ fixtureId: 102, players: [player(8)] },
	];
	const detailGeneration = deskGeneration + 10;
	const detailItemGeneration = options.detailItemGeneration ?? detailGeneration;
	const detailItems = detailFixtures.map((detail) => {
		const payload = detail.players;
		const sha = digest(payload);
		return {
			fixtureId: detail.fixtureId,
			key: `llm:data:v2:fpl:live-match:detail:2627:1:${detailItemGeneration}:${detail.fixtureId}:${sha}`,
			type: "string",
			count: payload.length,
			bytes: Buffer.byteLength(encode(payload), "utf8"),
			sha256: sha,
			payload: encode(payload),
			metadata: itemMeta(payload),
		};
	});
	const detailPublication = {
		contractVersion: "live-matches-v2",
		publicationId: publicationId(deskGeneration + 10),
		generation: detailGeneration,
		season: "2627",
		eventId: 1,
		finalized: options.detailFinalized ?? false,
		observedDeskGeneration: detailDeskGeneration,
		fixtureIdentityRevision,
		sourceCheckedAt: later,
		publishedAt: later,
		checkpointedAt,
		expectedNextCheckAt: "2026-08-31T10:01:30.000Z",
		staleAt: "2026-08-31T10:02:15.000Z",
		detail: { revision: digest(detailFixtures), contentUpdatedAt: later },
		fixtures: detailItems.map(({ payload: _payload, metadata: _metadata, ...item }) => item),
	};
	const detailRaw = JSON.stringify(detailPublication);
	const bundle = {
		eventId: 1,
		desk: {
			active: options.corruptDesk
				? {
						publication: JSON.stringify({
							...deskPublication,
							desk: { ...deskPublication.desk, sha256: "0".repeat(64) },
						}),
						payload: deskPayload,
						metadata: itemMeta(deskFixtures),
					}
				: {
						publication: JSON.stringify(deskPublication),
						payload: deskPayload,
						metadata: itemMeta(deskFixtures),
					},
			previous: emptyDesk,
		},
		detail: {
			active: options.omitDetail
				? emptyDetail
				: {
						publication: detailRaw,
						manifest: detailRaw,
						items: detailItems.map(({ payload, metadata, ...item }) => ({
							fixtureId: item.fixtureId,
							key: item.key,
							payload,
							metadata,
						})),
					},
			previous: emptyDetail,
		},
	};
	return { bundle, deskPublication, detailPublication };
};

const attachBundle = (redis: TestRedis, bundle: unknown): { set: (value: unknown) => void } => {
	let current = bundle;
	(redis as unknown as { eval: () => Promise<string> }).eval = async () => JSON.stringify(current);
	return {
		set: (value: unknown) => {
			current = value;
		},
	};
};

describe("Live Matches V2 read path", () => {
	beforeEach(() => resetLiveMatchProcessStateForTests());

	it("serves one root with fixture-specific DGW detail", async () => {
		const redis = new TestRedis();
		attachBundle(redis, buildBundle().bundle);
		const result = await graphql({
			schema,
			contextValue: buildSnapshotContext(redis),
			source: `query { liveMatchday(eventId: 1) { availability delivery { state servedFrom } snapshot { eventId matches { fixtureId players { id totalPoints stats { identifier points } } } } } }`,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.liveMatchday).toMatchObject({
			availability: "READY",
			delivery: { state: "FRESH", servedFrom: "REDIS_CURRENT" },
			snapshot: {
				eventId: 1,
				matches: [
					{ fixtureId: 101, players: [{ id: 9001, totalPoints: 3 }] },
					{ fixtureId: 102, players: [{ id: 9001, totalPoints: 8 }] },
				],
			},
		});
	});

	it("keeps a complete pre-kickoff desk fresh while detail is pending", async () => {
		const redis = new TestRedis();
		attachBundle(redis, buildBundle({ deskStarted: false, omitDetail: true }).bundle);
		const result = await graphql({
			schema,
			contextValue: buildSnapshotContext(redis),
			source: `query { liveMatchday(eventId: 1) { availability delivery { state reasonCodes } snapshot { detailDelivery { state reasonCodes } matches { started players { id } } } } }`,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.liveMatchday).toMatchObject({
			availability: "READY",
			delivery: {
				state: "FRESH",
				reasonCodes: expect.arrayContaining(["DETAIL_PENDING"]),
			},
			snapshot: {
				detailDelivery: { state: "PENDING", reasonCodes: ["DETAIL_PENDING"] },
				matches: [
					{ started: false, players: [] },
					{ started: false, players: [] },
				],
			},
		});
		expect(JSON.stringify(result.data?.liveMatchday)).not.toContain("DETAIL_OR_DESK_DEGRADED");
	});

	it("falls back to the previous desk when active exceeds the fixture cap", async () => {
		const redis = new TestRedis();
		const bundle = structuredClone(buildBundle().bundle) as any;
		bundle.desk.previous = structuredClone(bundle.desk.active);
		const activePublication = JSON.parse(bundle.desk.active.publication);
		activePublication.desk.count = LIVE_MATCH_MAX_FIXTURES + 1;
		bundle.desk.active.publication = JSON.stringify(activePublication);
		attachBundle(redis, bundle);

		const result = await readLiveMatchday(buildSnapshotContext(redis), 1);

		expect(result.desk?.servedFrom).toBe("REDIS_PREVIOUS");
		expect(result.desk?.fixtures).toHaveLength(2);
	});

	it("falls back to previous detail when active points outside its namespace", async () => {
		const redis = new TestRedis();
		const bundle = structuredClone(buildBundle().bundle) as any;
		bundle.detail.previous = structuredClone(bundle.detail.active);
		const activePublication = JSON.parse(bundle.detail.active.publication);
		activePublication.fixtures[0].key = `llm:data:v2:fpl:other:${activePublication.fixtures[0].sha256}`;
		bundle.detail.active.publication = JSON.stringify(activePublication);
		bundle.detail.active.manifest = bundle.detail.active.publication;
		bundle.detail.active.items[0].key = activePublication.fixtures[0].key;
		attachBundle(redis, bundle);

		const result = await readLiveMatchday(buildSnapshotContext(redis), 1);

		expect(result.detail?.servedFrom).toBe("REDIS_PREVIOUS");
		expect(result.detail?.fixtures).toHaveLength(2);
	});

	it("caps Redis detail fan-out before reading immutable item keys", () => {
		expect(LIVE_MATCHES_READ_BUNDLE_LUA).toContain(
			`#decoded.fixtures > ${LIVE_MATCH_MAX_FIXTURES}`
		);
		expect(LIVE_MATCHES_READ_BUNDLE_LUA).toContain(
			`total_bytes > ${2 * 1024 * 1024}`
		);
		expect(LIVE_MATCHES_READ_BUNDLE_LUA).not.toContain("manifest_decoded.fixtures");
		const detailScript = LIVE_MATCHES_READ_BUNDLE_LUA.slice(
			LIVE_MATCHES_READ_BUNDLE_LUA.indexOf("local function detail_candidate")
		);
		expect(detailScript.indexOf("local prefix =")).toBeLessThan(
			detailScript.indexOf("payload = read_string(item.key)")
		);
	});

	it("rejects a leading detail publication and keeps the desk available", async () => {
		const redis = new TestRedis();
		const built = buildBundle({ detailDeskGeneration: 3 });
		attachBundle(redis, built.bundle);
		const result = await readLiveMatchday(buildSnapshotContext(redis), 1);

		expect(result.desk?.servedFrom).toBe("REDIS_CURRENT");
		expect(result.detail).toBeNull();
	});

	it("accepts an immutable fixture item reused from an older detail generation", async () => {
		const redis = new TestRedis();
		attachBundle(redis, buildBundle({ detailItemGeneration: 4 }).bundle);
		const result = await readLiveMatchday(buildSnapshotContext(redis), 1);

		expect(result.detail?.publication.generation).toBe(12);
		expect(result.detail?.fixtures).toHaveLength(2);
	});

	it("bounds a missing detail checkpoint lookup for the same desk publication", async () => {
		const redis = new TestRedis();
		const control = attachBundle(redis, buildBundle({ omitDetail: true }).bundle);
		let databaseReads = 0;
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => {
				databaseReads += 1;
				return { rows: [] };
			},
		});

		const first = await readLiveMatchday(context, 1);
		const second = await readLiveMatchday(context, 1);

		expect(first.desk).not.toBeNull();
		expect(first.detail).toBeNull();
		expect(second.desk).not.toBeNull();
		expect(second.detail).toBeNull();
		expect(databaseReads).toBe(1);

		control.set(buildBundle().bundle);
		const refreshed = await readLiveMatchday(context, 1);
		expect(refreshed.detail?.fixtures).toHaveLength(2);
		expect(databaseReads).toBe(1);
	});

	it("uses the same-event process LKG when Redis becomes unavailable", async () => {
		const redis = new TestRedis();
		const control = attachBundle(redis, buildBundle().bundle);
		const context = buildSnapshotContext(redis);
		const warm = await readLiveMatchday(context, 1);
		expect(warm.desk?.servedFrom).toBe("REDIS_CURRENT");
		control.set(null);
		(redis as unknown as { eval: () => Promise<string> }).eval = async () => {
			throw new Error("redis unavailable");
		};

		const retained = await readLiveMatchday(context, 1);
		expect(retained.desk?.servedFrom).toBe("PROCESS_LKG");
		expect(retained.detail?.servedFrom).toBe("PROCESS_LKG");
		expect(retained.eventId).toBe(1);
	});

	it("uses the numeric season authority for PostgreSQL cold fallback", async () => {
		const redis = new TestRedis();
		(redis as unknown as { eval: () => Promise<string> }).eval = async () => {
			throw new Error("redis unavailable");
		};
		let parameters: unknown[] | undefined;
		const context = buildSnapshotContext(redis, {
			seasonId: 2026,
			seasonCode: "2627",
			databaseQuery: async (_query, values) => {
				parameters = values as unknown[];
				return { rows: [] };
			},
		});

		await readLiveMatchday(context, 1);

		expect(parameters).toEqual([2026, 1]);
	});

	it("attempts a bounded checkpoint scope lookup when Redis has no active event", async () => {
		const redis = new TestRedis();
		(redis as unknown as { eval: () => Promise<string> }).eval = async () => {
			throw new Error("redis unavailable");
		};
		let parameters: unknown[] | undefined;
		const context = buildSnapshotContext(redis, {
			databaseQuery: async (_query, values) => {
				parameters = values as unknown[];
				return { rows: [] };
			},
		});

		await readLiveMatchday(context);

		expect(parameters).toEqual([2026, null]);
	});

	it("does not label a provisional detail checkpoint as final", async () => {
		const redis = new TestRedis();
		attachBundle(redis, buildBundle({ deskState: "FINALIZED", checkpointed: true }).bundle);
		const result = await graphql({
			schema,
			contextValue: buildSnapshotContext(redis),
			source: `query { liveMatchday(eventId: 1) { delivery { state } snapshot { detailDelivery { state } } } }`,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.liveMatchday).toMatchObject({
			delivery: { state: "DEGRADED" },
			snapshot: { detailDelivery: { state: "DEGRADED" } },
		});
	});

	it("degrades a final-marked publication until both exact checkpoints exist", async () => {
		const redis = new TestRedis();
		attachBundle(redis, buildBundle({ deskState: "FINALIZED", detailFinalized: true }).bundle);
		const result = await graphql({
			schema,
			contextValue: buildSnapshotContext(redis),
			source: `query { liveMatchday(eventId: 1) { availability delivery { state reasonCodes } snapshot { detailDelivery { state reasonCodes } } } }`,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.liveMatchday).toMatchObject({
			availability: "READY",
			delivery: { state: "DEGRADED" },
			snapshot: {
				detailDelivery: {
					state: "DEGRADED",
					reasonCodes: ["FINAL_CHECKPOINT_PENDING"],
				},
			},
		});
		expect(JSON.stringify(result.data?.liveMatchday)).toContain("FINAL_CHECKPOINT_PENDING");
	});

	it("reports FINAL only after desk and detail are exactly checkpointed", async () => {
		const redis = new TestRedis();
		attachBundle(
			redis,
			buildBundle({
				deskState: "FINALIZED",
				detailFinalized: true,
				checkpointed: true,
			}).bundle
		);
		const result = await graphql({
			schema,
			contextValue: buildSnapshotContext(redis),
			source: `query { liveMatchday(eventId: 1) { availability delivery { state reasonCodes } snapshot { detailDelivery { state } } } }`,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.liveMatchday).toMatchObject({
			availability: "READY",
			delivery: { state: "FINAL" },
			snapshot: { detailDelivery: { state: "FINAL" } },
		});
	});

	it("keeps an older checkpointed final detail degraded behind the final desk", async () => {
		const redis = new TestRedis();
		attachBundle(
			redis,
			buildBundle({
				deskGeneration: 4,
				detailDeskGeneration: 3,
				deskState: "FINALIZED",
				detailFinalized: true,
				checkpointed: true,
			}).bundle
		);
		const result = await graphql({
			schema,
			contextValue: buildSnapshotContext(redis),
			source: `query { liveMatchday(eventId: 1) { availability delivery { state reasonCodes } snapshot { detailDelivery { state reasonCodes } } } }`,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.liveMatchday).toMatchObject({
			availability: "READY",
			delivery: {
				state: "DEGRADED",
				reasonCodes: expect.arrayContaining(["FINAL_CHECKPOINT_PENDING"]),
			},
			snapshot: {
				detailDelivery: {
					state: "DEGRADED",
					reasonCodes: ["FINAL_CHECKPOINT_PENDING"],
				},
			},
		});
	});
});
