import { beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { graphql } from "graphql";

import { schema } from "../../../src/graphql/schema";
import {
	LIVE_MATCHES_READ_POINTER_LUA,
	LIVE_MATCH_CHECKPOINT_DESK_SQL,
	LIVE_MATCH_CHECKPOINT_HEAD_SQL,
	LIVE_MATCH_CHECKPOINT_SQL,
	LIVE_MATCH_ACTIVE_EVENT_REVALIDATION_MS,
	LIVE_MATCH_EXPLICIT_CHECKPOINT_MISS_BUDGET,
	LIVE_MATCH_PROCESS_EVENT_CHECKED_AT_LIMIT,
	LIVE_MATCH_MAX_DETAIL_TOTAL_BYTES,
	LIVE_MATCH_MAX_FIXTURES,
	readLiveMatchday,
	resetLiveMatchProcessStateForTests,
} from "../../../src/domains/live-matches/repository";
import { buildSnapshotContext, TestRedis } from "../../helpers/data-publication";

const testClock = Date.now();
const now = new Date(testClock - 60_000).toISOString();
const later = new Date(testClock - 30_000).toISOString();
const expectedNextCheckAt = new Date(testClock + 30_000).toISOString();
const staleAt = new Date(testClock + 37_500).toISOString();

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

type DeskBundleSlot = {
	publication: string | null;
	payload: string | null;
	metadata: string | null;
};

type DetailBundleItem = {
	fixtureId: number;
	key: string;
	payload: string | null;
	metadata: string;
};

type DetailBundleSlot = {
	publication: string | null;
	manifest: string | null;
	items: DetailBundleItem[];
};

type LiveMatchTestBundle = {
	eventId: number | null;
	desk: { active: DeskBundleSlot; previous: DeskBundleSlot };
	detail: { active: DetailBundleSlot; previous: DetailBundleSlot };
};

const emptyDesk: DeskBundleSlot = { publication: null, payload: null, metadata: null };
const emptyDetail: DetailBundleSlot = { publication: null, manifest: null, items: [] };

const fixture = (fixtureId: number, awayTeamId: number, started = true, eventId = 1) => ({
	fixtureId,
	eventId,
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

const deskLifecycleDigest = (state: "PRE_DEADLINE" | "LIVE_ACTIVE" | "FINALIZED"): string =>
	digest({ state });

const deskFixtureIdentityDigest = (fixtures: readonly ReturnType<typeof fixture>[]): string =>
	digest(
		fixtures.map((value) => ({
			fixtureId: value.fixtureId,
			eventId: value.eventId,
			homeTeamId: value.homeTeamId,
			homeTeamName: value.homeTeamName,
			homeTeamShortName: value.homeTeamShortName,
			awayTeamId: value.awayTeamId,
			awayTeamName: value.awayTeamName,
			awayTeamShortName: value.awayTeamShortName,
			kickoffTime: value.kickoffTime,
		}))
	);

const deskScoreStateDigest = (fixtures: readonly ReturnType<typeof fixture>[]): string =>
	digest(
		fixtures.map((value) => ({
			fixtureId: value.fixtureId,
			homeScore: value.homeScore,
			awayScore: value.awayScore,
			minutes: value.minutes,
			started: value.started,
			finished: value.finished,
			finishedProvisional: value.finishedProvisional,
		}))
	);

const player = (totalPoints: number) => ({
	id: 9001,
	webName: "DGW Player",
	position: 3,
	teamId: 1,
	price: 55,
	totalPoints,
	stats: [{ identifier: "bps", value: totalPoints * 10, awardedPoints: totalPoints }],
});

const publicationId = (generation: number): string =>
	`00000000-0000-4000-8000-${String(generation).padStart(12, "0")}`;

const buildBundle = (
	options: {
		deskGeneration?: number;
		deskState?: "PRE_DEADLINE" | "LIVE_ACTIVE" | "FINALIZED";
		detailDeskGeneration?: number;
		detailGeneration?: number;
		detailItemGeneration?: number;
		corruptDesk?: boolean;
		checkpointed?: boolean;
		omitDetail?: boolean;
		detailFinalized?: boolean;
		deskStarted?: boolean;
		eventId?: number;
	} = {}
) => {
	const eventId = options.eventId ?? 1;
	const deskGeneration = options.deskGeneration ?? 2;
	const deskState = options.deskState ?? "LIVE_ACTIVE";
	const checkpointedAt = options.checkpointed ? later : null;
	const detailDeskGeneration = options.detailDeskGeneration ?? deskGeneration;
	const detailGeneration = options.detailGeneration ?? deskGeneration + 10;
	const deskFixtures = [
		fixture(101, 2, options.deskStarted ?? true, eventId),
		fixture(102, 3, options.deskStarted ?? true, eventId),
	];
	const deskPayload = encode(deskFixtures);
	const fixtureIdentityRevision = deskFixtureIdentityDigest(deskFixtures);
	const revisions = {
		lifecycle: { revision: deskLifecycleDigest(deskState), contentUpdatedAt: now },
		fixtureIdentity: { revision: fixtureIdentityRevision, contentUpdatedAt: now },
		scoreState: {
			revision: deskScoreStateDigest(deskFixtures),
			contentUpdatedAt: later,
		},
	};
	const deskPublication = {
		contractVersion: "live-matches-v3",
		publicationId: publicationId(deskGeneration),
		generation: deskGeneration,
		season: "2627",
		eventId,
		state: deskState,
		sourceCheckedAt: later,
		publishedAt: later,
		checkpointedAt,
		expectedNextCheckAt,
		staleAt,
		revisions,
		desk: {
			name: "desk",
			key: `llm:data:v3:fpl:live-match:desk:2627:${eventId}:${deskGeneration}:desk`,
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
	const detailItemGeneration = options.detailItemGeneration ?? detailGeneration;
	const detailItems = detailFixtures.map((detail) => {
		const payload = detail.players;
		const sha = digest(payload);
		return {
			fixtureId: detail.fixtureId,
			key: `llm:data:v3:fpl:live-match:detail:2627:${eventId}:${detailItemGeneration}:${detail.fixtureId}:${sha}`,
			type: "string",
			count: payload.length,
			bytes: Buffer.byteLength(encode(payload), "utf8"),
			sha256: sha,
			payload: encode(payload),
			metadata: itemMeta(payload),
		};
	});
	const detailPublication = {
		contractVersion: "live-matches-v3",
		publicationId: publicationId(detailGeneration),
		generation: detailGeneration,
		season: "2627",
		eventId,
		finalized: options.detailFinalized ?? false,
		observedDeskGeneration: detailDeskGeneration,
		fixtureIdentityRevision,
		sourceCheckedAt: later,
		publishedAt: later,
		checkpointedAt,
		expectedNextCheckAt,
		staleAt,
		detail: { revision: digest(detailFixtures), contentUpdatedAt: later },
		fixtures: detailItems.map(({ payload: _payload, metadata: _metadata, ...item }) => item),
	};
	const detailRaw = JSON.stringify(detailPublication);
	const bundle: LiveMatchTestBundle = {
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
	return { bundle, deskPublication, detailPublication, deskFixtures, detailFixtures };
};

const buildCheckpointRow = (
	options: { eventId?: number; deskGeneration?: number; detailGeneration?: number } = {}
) => {
	const built = buildBundle({
		checkpointed: true,
		eventId: options.eventId,
		deskGeneration: options.deskGeneration,
		detailGeneration: options.detailGeneration,
	});
	return {
		event_id: built.deskPublication.eventId,
		desk: {
			contract_version: "live-matches-v3",
			publication_id: built.deskPublication.publicationId,
			generation: built.deskPublication.generation,
			state: built.deskPublication.state,
			manifest: built.deskPublication,
			revisions: built.deskPublication.revisions,
			fixture_coverage: {
				fixture_ids: built.deskFixtures.map((fixture) => fixture.fixtureId),
				started_fixture_ids: built.deskFixtures
					.filter(
						(fixture) =>
							fixture.started ||
							fixture.finished ||
							fixture.finishedProvisional ||
							fixture.minutes > 0
					)
					.map((fixture) => fixture.fixtureId),
			},
			payload: built.deskFixtures,
			row_count: built.deskFixtures.length,
			payload_bytes: Buffer.byteLength(encode(built.deskFixtures), "utf8"),
			payload_sha256: digest(built.deskFixtures),
			source_checked_at: built.deskPublication.sourceCheckedAt,
			published_at: built.deskPublication.publishedAt,
			checkpointed_at: built.deskPublication.checkpointedAt,
			expected_next_check_at: built.deskPublication.expectedNextCheckAt,
			stale_at: built.deskPublication.staleAt,
		},
		detail: {
			contract_version: "live-matches-v3",
			publication_id: built.detailPublication.publicationId,
			generation: built.detailPublication.generation,
			state: built.detailPublication.finalized ? "FINALIZED" : "PROVISIONAL",
			observed_desk_generation: built.detailPublication.observedDeskGeneration,
			fixture_identity_revision: built.detailPublication.fixtureIdentityRevision,
			manifest: built.detailPublication,
			revisions: { detail: built.detailPublication.detail },
			payload: built.detailFixtures,
			row_count: built.detailFixtures.length,
			payload_bytes: Buffer.byteLength(encode(built.detailFixtures), "utf8"),
			payload_sha256: digest(built.detailFixtures),
			source_checked_at: built.detailPublication.sourceCheckedAt,
			published_at: built.detailPublication.publishedAt,
			checkpointed_at: built.detailPublication.checkpointedAt,
			expected_next_check_at: built.detailPublication.expectedNextCheckAt,
			stale_at: built.detailPublication.staleAt,
		},
	};
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

describe("Live Matches V3 read path", () => {
	beforeEach(() => resetLiveMatchProcessStateForTests());

	it("does not expose lifecycle context as a fabricated match-publication field", () => {
		const snapshot = schema.getType("LiveMatchdaySnapshot");
		expect(
			snapshot && "getFields" in snapshot ? snapshot.getFields().nextEventId : undefined
		).toBeUndefined();
	});

	it("labels an empty active-event window explicitly instead of as infrastructure failure", async () => {
		const redis = new TestRedis();
		attachBundle(redis, {
			eventId: null,
			pointer: "active",
			desk: {
				active: { publication: null, payload: null, metadata: null },
				previous: { publication: null, payload: null, metadata: null },
			},
			detail: {
				active: { publication: null, manifest: null, items: [] },
				previous: { publication: null, manifest: null, items: [] },
			},
		});
		const result = await graphql({
			schema,
			contextValue: buildSnapshotContext(redis, { databaseQuery: async () => ({ rows: [] }) }),
			source: `query { liveMatchday { availability delivery { state servedFrom reasonCodes } snapshot { eventId } } }`,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.liveMatchday).toEqual({
			availability: "UNAVAILABLE",
			delivery: {
				state: "UNAVAILABLE",
				servedFrom: null,
				reasonCodes: ["NO_ACTIVE_EVENT"],
			},
			snapshot: null,
		});
	});

	it("caches an empty unscoped checkpoint result during an eventless window", async () => {
		const redis = new TestRedis();
		attachBundle(redis, {
			eventId: null,
			pointer: "active",
			desk: { active: emptyDesk, previous: emptyDesk },
			detail: { active: emptyDetail, previous: emptyDetail },
		});
		let databaseReads = 0;
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => {
				databaseReads += 1;
				return { rows: [] };
			},
		});

		const first = await readLiveMatchday(context);
		const second = await readLiveMatchday(context);

		expect(first.eventId).toBeNull();
		expect(second.eventId).toBeNull();
		expect(databaseReads).toBe(1);
	});

	it("serves one root with fixture-specific DGW detail", async () => {
		const redis = new TestRedis();
		attachBundle(redis, buildBundle().bundle);
		let databaseReads = 0;
		const result = await graphql({
			schema,
			contextValue: buildSnapshotContext(redis, {
				databaseQuery: async () => {
					databaseReads += 1;
					throw new Error("warm Live Matches reads must not touch PostgreSQL");
				},
			}),
			source: `query { liveMatchday(eventId: 1) { availability delivery { state servedFrom } snapshot { eventId revisions { detailObservation detailPublicationId detailGeneration playerDetail } matches { fixtureId players { id price totalPoints stats { identifier awardedPoints } } } } } }`,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.liveMatchday).toMatchObject({
			availability: "READY",
			delivery: { state: "FRESH", servedFrom: "REDIS_CURRENT" },
			snapshot: {
				eventId: 1,
				revisions: {
					detailObservation: expect.any(String) as unknown,
					detailPublicationId: publicationId(12),
					detailGeneration: 12,
					playerDetail: expect.any(String) as unknown,
				},
				matches: [
					{ fixtureId: 101, players: [{ id: 9001, price: 55, totalPoints: 3 }] },
					{ fixtureId: 102, players: [{ id: 9001, price: 55, totalPoints: 8 }] },
				],
			},
		});
		expect(databaseReads).toBe(0);
	});

	it("reuses verified immutable Redis decodes without changing the served source", async () => {
		const redis = new TestRedis();
		attachBundle(redis, buildBundle().bundle);
		const context = buildSnapshotContext(redis);

		const first = await readLiveMatchday(context, 1, "FULL");
		const second = await readLiveMatchday(context, 1, "FULL");

		expect(second.desk?.servedFrom).toBe("REDIS_CURRENT");
		expect(second.detail?.servedFrom).toBe("REDIS_CURRENT");
		expect(second.desk?.fixtures).toBe(first.desk?.fixtures);
		expect(second.detail?.fixtures).toBe(first.detail?.fixtures);
	});

	it("does not reuse a verified decode after the Redis publication changes", async () => {
		const redis = new TestRedis();
		const bundle = attachBundle(redis, buildBundle().bundle);
		const context = buildSnapshotContext(redis);

		await readLiveMatchday(context, 1, "FULL");
		const newer = buildBundle({
			deskGeneration: 3,
			detailDeskGeneration: 3,
			detailGeneration: 13,
			detailItemGeneration: 13,
		});
		bundle.set(newer.bundle);

		const result = await readLiveMatchday(context, 1, "FULL");

		expect(result.desk?.publication.publicationId).toBe(publicationId(3));
		expect(result.detail?.publication.publicationId).toBe(publicationId(13));
	});

	it("selects HEAD, DESK, and FULL from the actual selection tree", async () => {
		const redis = new TestRedis();
		const bundle = buildBundle().bundle;
		const modes: unknown[] = [];
		(redis as unknown as { eval: (...args: unknown[]) => Promise<string> }).eval = async (
			...args
		) => {
			modes.push(args.at(-1));
			return JSON.stringify(bundle);
		};
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => {
				throw new Error("selection-mode reads must not touch PostgreSQL");
			},
		});

		const head = await graphql({
			schema,
			contextValue: context,
			source: `query AnyOperation { liveMatchday(eventId: 1) { snapshot { eventId revisions { deskGeneration } } } }`,
		});
		const desk = await graphql({
			schema,
			contextValue: context,
			source: `query Renamed { liveMatchday(eventId: 1) { snapshot { matches { fixtureId homeScore } } } }`,
		});
		const full = await graphql({
			schema,
			contextValue: context,
			source: `query WithAlias { liveMatchday(eventId: 1) { snapshot { matches { fixtureId players { id stats { identifier awardedPoints } } } } } }`,
		});

		expect(head.errors).toBeUndefined();
		expect(desk.errors).toBeUndefined();
		expect(full.errors).toBeUndefined();
		expect(modes).toEqual(["HEAD", "DESK", "FULL"]);
	});

	it("keeps the HEAD response metadata-only and does not cold-read detail payloads", async () => {
		const redis = new TestRedis();
		attachBundle(redis, buildBundle().bundle);
		let databaseReads = 0;

		const result = await readLiveMatchday(
			buildSnapshotContext(redis, {
				databaseQuery: async () => {
					databaseReads += 1;
					throw new Error("HEAD reads must not touch PostgreSQL");
				},
			}),
			1,
			"HEAD"
		);

		expect(result.desk?.payloadLoaded).toBe(false);
		expect(result.desk?.fixtures).toEqual([]);
		expect(result.detail).toBeNull();
		expect(result.detailObservation?.payloadLoaded).toBe(false);
		expect(result.detailObservation?.fixtures).toEqual([]);
		expect(databaseReads).toBe(0);
	});

	it("does not require immutable detail bodies for HEAD or DESK metadata reads", async () => {
		for (const mode of ["HEAD", "DESK"] as const) {
			resetLiveMatchProcessStateForTests();
			const redis = new TestRedis();
			const bundle = structuredClone(buildBundle().bundle);
			bundle.detail.active.items = bundle.detail.active.items.map((item) => ({
				...item,
				payload: null,
			}));
			attachBundle(redis, bundle);

			const result = await readLiveMatchday(buildSnapshotContext(redis), 1, mode);

			expect(result.desk).not.toBeNull();
			expect(result.detail).toBeNull();
			expect(result.detailObservation?.payloadLoaded).toBe(false);
			expect(result.detailObservation?.fixtures).toEqual([]);
		}
	});

	it("keeps unverified detail metadata out of the authoritative candidate", async () => {
		const redis = new TestRedis();
		const built = buildBundle();
		const bundle = structuredClone(built.bundle);
		const activeItem = bundle.detail.active.items[0];
		if (!activeItem || activeItem.payload === null) throw new Error("missing active detail item");
		// Preserve the byte length and sidecar metadata while changing the body.
		activeItem.payload = activeItem.payload.replace('"position":3', '"position":4');
		attachBundle(redis, bundle);

		const head = await readLiveMatchday(buildSnapshotContext(redis), 1, "HEAD");
		const full = await readLiveMatchday(buildSnapshotContext(redis), 1, "FULL");

		expect(head.detail).toBeNull();
		expect(head.detailObservation?.servedFrom).toBe("REDIS_CURRENT");
		expect(head.detailObservation?.payloadLoaded).toBe(false);
		expect(head.detailObservation?.observationRevision).not.toBe(
			built.detailPublication.detail.revision
		);
		expect(full.detail).toBeNull();
	});

	it("does not promote an aggregate revision that was not recomputed from detail bodies", async () => {
		const redis = new TestRedis();
		const bundle = structuredClone(buildBundle().bundle);
		if (bundle.detail.active.publication === null)
			throw new Error("missing active detail publication");
		const publication = JSON.parse(bundle.detail.active.publication) as {
			detail: { revision: string };
		};
		publication.detail.revision = "f".repeat(64);
		bundle.detail.active.publication = JSON.stringify(publication);
		bundle.detail.active.manifest = bundle.detail.active.publication;
		attachBundle(redis, bundle);

		const head = await readLiveMatchday(buildSnapshotContext(redis), 1, "HEAD");
		const full = await readLiveMatchday(buildSnapshotContext(redis), 1, "FULL");

		expect(head.detail).toBeNull();
		expect(head.detailObservation?.observationRevision).toMatch(/^[0-9a-f]{64}$/);
		expect(full.detail).toBeNull();

		const response = await graphql({
			schema,
			contextValue: buildSnapshotContext(redis),
			source: `query { liveMatchday(eventId: 1) { snapshot { revisions { detailObservation detailPublicationId detailGeneration playerDetail } } } }`,
		});

		expect(response.errors).toBeUndefined();
		expect(response.data?.liveMatchday).toMatchObject({
			snapshot: {
				revisions: {
					detailObservation: expect.any(String) as unknown,
					detailPublicationId: null,
					detailGeneration: null,
					playerDetail: null,
				},
			},
		});
	});

	it("rejects metadata when an immutable detail item is missing and uses previous", async () => {
		const redis = new TestRedis();
		const bundle = structuredClone(buildBundle().bundle);
		bundle.detail.previous = structuredClone(bundle.detail.active);
		bundle.detail.active.items = [];
		attachBundle(redis, bundle);

		const result = await readLiveMatchday(buildSnapshotContext(redis), 1, "HEAD");

		expect(result.detail).toBeNull();
		expect(result.detailObservation?.servedFrom).toBe("REDIS_PREVIOUS");
		expect(result.detailObservation?.payloadLoaded).toBe(false);
	});

	it("rejects a corrupt desk item before accepting a HEAD metadata candidate", async () => {
		const redis = new TestRedis();
		attachBundle(redis, buildBundle({ corruptDesk: true }).bundle);

		const result = await readLiveMatchday(buildSnapshotContext(redis), 1, "HEAD");

		expect(result.desk).toBeNull();
		expect(result.detail).toBeNull();
	});

	it("rejects unknown fields in desk publication metadata", async () => {
		const mutations: Array<(publication: Record<string, unknown>) => void> = [
			(publication) => {
				publication.retiredField = true;
			},
			(publication) => {
				(publication.revisions as Record<string, unknown>).retiredField = true;
			},
			(publication) => {
				(
					(publication.revisions as Record<string, unknown>).lifecycle as Record<string, unknown>
				).retiredField = true;
			},
			(publication) => {
				(publication.desk as Record<string, unknown>).retiredField = true;
			},
		];

		for (const mutate of mutations) {
			const redis = new TestRedis();
			const bundle = structuredClone(buildBundle().bundle);
			const active = bundle.desk.active;
			if (!active.publication) throw new Error("missing active desk publication");
			const publication = JSON.parse(active.publication) as Record<string, unknown>;
			mutate(publication);
			active.publication = JSON.stringify(publication);
			attachBundle(redis, bundle);

			const result = await readLiveMatchday(buildSnapshotContext(redis), 1, "HEAD");

			expect(result.desk).toBeNull();
			expect(result.detail).toBeNull();
		}
	});

	it("rejects unknown fields in detail publication metadata", async () => {
		const mutations: Array<(publication: Record<string, unknown>) => void> = [
			(publication) => {
				publication.retiredField = true;
			},
			(publication) => {
				(publication.detail as Record<string, unknown>).retiredField = true;
			},
			(publication) => {
				(publication.fixtures as Array<Record<string, unknown>>)[0].retiredField = true;
			},
		];

		for (const mutate of mutations) {
			const redis = new TestRedis();
			const bundle = structuredClone(buildBundle().bundle);
			const active = bundle.detail.active;
			if (!active.publication) throw new Error("missing active detail publication");
			const publication = JSON.parse(active.publication) as Record<string, unknown>;
			mutate(publication);
			active.publication = JSON.stringify(publication);
			active.manifest = active.publication;
			attachBundle(redis, bundle);

			const result = await readLiveMatchday(buildSnapshotContext(redis), 1, "HEAD");

			expect(result.desk).not.toBeNull();
			expect(result.detail).toBeNull();
		}
	});

	it("rejects retired fields in a desk fixture before accepting HEAD metadata", async () => {
		const redis = new TestRedis();
		const bundle = structuredClone(buildBundle().bundle);
		const active = bundle.desk.active;
		if (!active.publication || !active.payload || !active.metadata)
			throw new Error("missing active desk publication");
		const fixtures = JSON.parse(active.payload) as Array<Record<string, unknown>>;
		const firstFixture = fixtures[0];
		if (!firstFixture) throw new Error("missing desk fixture");
		firstFixture.retiredField = true;
		const corruptedPayload = encode(fixtures);
		const publication = JSON.parse(active.publication) as {
			desk: { bytes: number; sha256: string };
		};
		publication.desk.bytes = Buffer.byteLength(corruptedPayload, "utf8");
		publication.desk.sha256 = digest(fixtures);
		active.payload = corruptedPayload;
		active.metadata = itemMeta(fixtures);
		active.publication = JSON.stringify(publication);
		attachBundle(redis, bundle);

		const result = await readLiveMatchday(buildSnapshotContext(redis), 1, "HEAD");

		expect(result.desk).toBeNull();
		expect(result.detail).toBeNull();
	});

	it("rejects same-length detail corruption before accepting a FULL candidate", async () => {
		const redis = new TestRedis();
		const bundle = structuredClone(buildBundle().bundle);
		const item = bundle.detail.active.items[0];
		if (!item) throw new Error("missing active detail item");
		if (item.payload === null) throw new Error("missing active detail payload");
		const players = JSON.parse(item.payload) as Array<Record<string, unknown>>;
		const firstPlayer = players[0];
		if (!firstPlayer) throw new Error("missing detail player");
		firstPlayer.totalPoints = 4;
		const corruptedPayload = encode(players);
		expect(Buffer.byteLength(corruptedPayload, "utf8")).toBe(
			Buffer.byteLength(item.payload, "utf8")
		);
		item.payload = corruptedPayload;
		attachBundle(redis, bundle);

		const result = await readLiveMatchday(buildSnapshotContext(redis), 1, "FULL");

		expect(result.desk).not.toBeNull();
		expect(result.detail).toBeNull();
	});

	it("rejects an invalid detail player before accepting a FULL candidate", async () => {
		const redis = new TestRedis();
		const bundle = structuredClone(buildBundle().bundle);
		const active = bundle.detail.active;
		if (active.publication === null || active.items[0] === undefined)
			throw new Error("missing active detail");
		const publication = JSON.parse(active.publication) as {
			fixtures: Array<{
				fixtureId: number;
				key: string;
				count: number;
				bytes: number;
				sha256: string;
			}>;
			detail: { revision: string };
		};
		const invalidPlayers = [{ ...player(3), retiredField: true }];
		const payload = encode(invalidPlayers);
		const checksum = digest(invalidPlayers);
		const item = publication.fixtures[0];
		if (!item) throw new Error("missing first detail descriptor");
		const nextKey = item.key.replace(/:[0-9a-f]{64}$/, `:${checksum}`);
		publication.fixtures[0] = {
			...item,
			key: nextKey,
			bytes: Buffer.byteLength(payload, "utf8"),
			sha256: checksum,
		};
		active.items[0] = {
			...active.items[0],
			key: nextKey,
			payload,
			metadata: itemMeta(invalidPlayers),
		};
		publication.detail.revision = digest([
			{ fixtureId: 101, players: invalidPlayers },
			{ fixtureId: 102, players: [player(8)] },
		]);
		active.publication = JSON.stringify(publication);
		active.manifest = active.publication;
		attachBundle(redis, bundle);

		const result = await readLiveMatchday(buildSnapshotContext(redis), 1, "FULL");

		expect(result.desk).not.toBeNull();
		expect(result.detail).toBeNull();
	});

	it("rejects a detail player whose team is outside the desk fixture", async () => {
		const redis = new TestRedis();
		const bundle = structuredClone(buildBundle().bundle);
		const active = bundle.detail.active;
		if (active.publication === null || active.items[0] === undefined)
			throw new Error("missing active detail");
		const publication = JSON.parse(active.publication) as {
			fixtures: Array<{
				fixtureId: number;
				key: string;
				count: number;
				bytes: number;
				sha256: string;
			}>;
			detail: { revision: string };
		};
		const incoherentPlayers = [{ ...player(3), teamId: 99 }];
		const payload = encode(incoherentPlayers);
		const checksum = digest(incoherentPlayers);
		const item = publication.fixtures[0];
		if (!item) throw new Error("missing first detail descriptor");
		const nextKey = item.key.replace(/:[0-9a-f]{64}$/, `:${checksum}`);
		publication.fixtures[0] = {
			...item,
			key: nextKey,
			bytes: Buffer.byteLength(payload, "utf8"),
			sha256: checksum,
		};
		active.items[0] = {
			...active.items[0],
			key: nextKey,
			payload,
			metadata: itemMeta(incoherentPlayers),
		};
		publication.detail.revision = digest([
			{ fixtureId: 101, players: incoherentPlayers },
			{ fixtureId: 102, players: [player(8)] },
		]);
		active.publication = JSON.stringify(publication);
		active.manifest = active.publication;
		attachBundle(redis, bundle);

		const result = await readLiveMatchday(buildSnapshotContext(redis), 1, "FULL");

		expect(result.desk).not.toBeNull();
		expect(result.detail).toBeNull();
	});

	it("rejects a detail candidate with a mismatched aggregate revision", async () => {
		const redis = new TestRedis();
		const bundle = structuredClone(buildBundle().bundle);
		const active = bundle.detail.active;
		if (!active.publication) throw new Error("missing active detail publication");
		const publication = JSON.parse(active.publication) as {
			detail: { revision: string };
		};
		publication.detail.revision = "f".repeat(64);
		active.publication = JSON.stringify(publication);
		active.manifest = active.publication;
		attachBundle(redis, bundle);

		const result = await readLiveMatchday(buildSnapshotContext(redis), 1, "FULL");

		expect(result.desk).not.toBeNull();
		expect(result.detail).toBeNull();
	});

	it("labels an invalid explicit event id instead of reporting an empty active window", async () => {
		const redis = new TestRedis();
		let databaseReads = 0;
		const result = await graphql({
			schema,
			contextValue: buildSnapshotContext(redis, {
				databaseQuery: async () => {
					databaseReads += 1;
					throw new Error("invalid event ids must not read PostgreSQL");
				},
			}),
			source: `query { liveMatchday(eventId: 0) { availability delivery { state servedFrom reasonCodes } snapshot { eventId } } }`,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.liveMatchday).toEqual({
			availability: "UNAVAILABLE",
			delivery: {
				state: "UNAVAILABLE",
				servedFrom: null,
				reasonCodes: ["INVALID_EVENT_ID"],
			},
			snapshot: null,
		});
		expect(databaseReads).toBe(0);
	});

	it("does not advertise manifest-only detail as a full HEAD LKG", async () => {
		const redis = new TestRedis();
		attachBundle(redis, buildBundle().bundle);

		const result = await graphql({
			schema,
			contextValue: buildSnapshotContext(redis),
			source: `query { liveMatchday(eventId: 1) { delivery { state } snapshot { detailDelivery { state servedFrom reasonCodes } } } }`,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.liveMatchday).toMatchObject({
			delivery: { state: "DEGRADED" },
			snapshot: {
				detailDelivery: {
					state: "DEGRADED",
					servedFrom: "REDIS_CURRENT",
					reasonCodes: ["DETAIL_METADATA_ONLY"],
				},
			},
		});
	});

	it("uses retained fixture coverage instead of lifecycle state for metadata activity", async () => {
		const readState = async (deskState: "PRE_DEADLINE" | "LIVE_ACTIVE", started: boolean) => {
			const redis = new TestRedis();
			attachBundle(
				redis,
				buildBundle({
					deskState,
					deskStarted: started,
					omitDetail: true,
				}).bundle
			);
			const result = await graphql({
				schema,
				contextValue: buildSnapshotContext(redis),
				source: `query { liveMatchday(eventId: 1) { snapshot { detailDelivery { state } } } }`,
			});
			if (result.errors) throw result.errors[0];
			return result.data?.liveMatchday;
		};

		expect(await readState("PRE_DEADLINE", true)).toMatchObject({
			snapshot: { detailDelivery: { state: "DEGRADED" } },
		});
		expect(await readState("LIVE_ACTIVE", false)).toMatchObject({
			snapshot: { detailDelivery: { state: "PENDING" } },
		});
	});

	it("applies fragment aliases and runtime include/skip directives to read mode", async () => {
		const redis = new TestRedis();
		const bundle = buildBundle().bundle;
		const modes: unknown[] = [];
		(redis as unknown as { eval: (...args: unknown[]) => Promise<string> }).eval = async (
			...args
		) => {
			modes.push(args.at(-1));
			return JSON.stringify(bundle);
		};
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => {
				throw new Error("directive reads must not touch PostgreSQL");
			},
		});

		const result = await graphql({
			schema,
			contextValue: context,
			variableValues: { includePlayers: false, includeMatches: true },
			source: `query DirectiveModes($includePlayers: Boolean!, $includeMatches: Boolean!) {
				liveMatchday(eventId: 1) {
					snapshot {
						...SnapshotFields @include(if: $includeMatches)
					}
				}
			}
			fragment SnapshotFields on LiveMatchdaySnapshot {
				matches {
					fixtureId
					players @include(if: $includePlayers) { id }
				}
			}`,
		});

		expect(result.errors).toBeUndefined();
		expect(modes).toEqual(["DESK"]);
	});

	it("rejects a publication with an invalid V3 identity", async () => {
		const redis = new TestRedis();
		const bundle = structuredClone(buildBundle().bundle);
		if (bundle.desk.active.publication === null) throw new Error("missing active desk");
		const publication = JSON.parse(bundle.desk.active.publication) as { publicationId: string };
		publication.publicationId = "not-a-publication";
		bundle.desk.active.publication = JSON.stringify(publication);
		attachBundle(redis, bundle);

		const result = await readLiveMatchday(buildSnapshotContext(redis), 1);

		expect(result.desk).toBeNull();
		expect(result.detail).toBeNull();
	});

	it("rejects metadata detail that omits a started desk fixture", async () => {
		const redis = new TestRedis();
		const bundle = structuredClone(buildBundle().bundle);
		if (!bundle.detail.active.publication) throw new Error("missing detail publication");
		const publication = JSON.parse(bundle.detail.active.publication) as {
			fixtures: unknown[];
		};
		publication.fixtures = publication.fixtures.slice(0, 1);
		bundle.detail.active.publication = JSON.stringify(publication);
		bundle.detail.active.manifest = bundle.detail.active.publication;
		attachBundle(redis, bundle);

		const result = await readLiveMatchday(buildSnapshotContext(redis), 1, "HEAD");

		expect(result.desk).not.toBeNull();
		expect(result.detail).toBeNull();
	});

	it("rejects metadata detail with an empty started-fixture descriptor", async () => {
		const redis = new TestRedis();
		const bundle = structuredClone(buildBundle().bundle);
		if (!bundle.detail.active.publication) throw new Error("missing detail publication");
		const publication = JSON.parse(bundle.detail.active.publication) as {
			fixtures: Array<{ fixtureId: number; count: number }>;
		};
		const firstFixture = publication.fixtures[0];
		if (!firstFixture) throw new Error("missing detail fixture descriptor");
		firstFixture.count = 0;
		bundle.detail.active.publication = JSON.stringify(publication);
		bundle.detail.active.manifest = bundle.detail.active.publication;
		attachBundle(redis, bundle);

		const result = await readLiveMatchday(buildSnapshotContext(redis), 1, "HEAD");

		expect(result.desk).not.toBeNull();
		expect(result.detail).toBeNull();
	});

	it("never selects sealed V2 rows during PostgreSQL cold fallback", () => {
		expect(LIVE_MATCH_CHECKPOINT_SQL).toContain("checkpoint.contract_version = 'live-matches-v3'");
		expect(LIVE_MATCH_CHECKPOINT_SQL.match(/contract_version = 'live-matches-v3'/g)).toHaveLength(
			3
		);
	});

	it("does not materialize detail checkpoint payloads for HEAD or DESK cold reads", () => {
		expect(LIVE_MATCH_CHECKPOINT_HEAD_SQL).toContain("jsonb_build_object(");
		expect(LIVE_MATCH_CHECKPOINT_DESK_SQL).toContain("jsonb_build_object(");
		expect(LIVE_MATCH_CHECKPOINT_HEAD_SQL).toContain("WITH ORDINALITY");
		expect(LIVE_MATCH_CHECKPOINT_HEAD_SQL).toContain("ORDER BY elements.fixture_ordinality");
		expect(LIVE_MATCH_CHECKPOINT_HEAD_SQL).not.toContain("ORDER BY fixture_item->>'fixtureId'");
		expect(LIVE_MATCH_CHECKPOINT_HEAD_SQL.match(/'payload', checkpoint\.payload/g)).toHaveLength(1);
		expect(LIVE_MATCH_CHECKPOINT_DESK_SQL.match(/to_jsonb\(checkpoint\)/g)).toHaveLength(1);
		expect(LIVE_MATCH_CHECKPOINT_SQL.match(/to_jsonb\(checkpoint\)/g)).toHaveLength(2);
	});

	it("uses compact PostgreSQL projections for HEAD and DESK reads", async () => {
		const coldRead = async (mode: "HEAD" | "DESK" | "FULL") => {
			resetLiveMatchProcessStateForTests();
			const redis = new TestRedis();
			(redis as unknown as { eval: () => Promise<string> }).eval = async () => {
				throw new Error("redis unavailable");
			};
			let query = "";
			const row = buildCheckpointRow();
			if (mode !== "FULL") {
				Object.defineProperty(row.detail, "payload", {
					configurable: true,
					get: () => {
						throw new Error("metadata-only checkpoint parser read detail payload");
					},
				});
			}
			const result = await readLiveMatchday(
				buildSnapshotContext(redis, {
					databaseQuery: async (sql) => {
						query = String(sql);
						return { rows: [row] };
					},
				}),
				1,
				mode
			);
			return { query, result };
		};

		const head = await coldRead("HEAD");
		expect(head.query).toBe(LIVE_MATCH_CHECKPOINT_HEAD_SQL);
		expect(head.result.desk?.payloadLoaded).toBe(false);
		expect(head.result.detail).toBeNull();
		expect(head.result.desk?.fixtures).toEqual([]);

		const desk = await coldRead("DESK");
		expect(desk.query).toBe(LIVE_MATCH_CHECKPOINT_DESK_SQL);
		expect(desk.result.desk?.payloadLoaded).not.toBe(false);
		expect(desk.result.detail).toBeNull();
		expect(desk.result.desk?.fixtures).toHaveLength(2);

		const full = await coldRead("FULL");
		expect(full.query).toBe(LIVE_MATCH_CHECKPOINT_SQL);
		expect(full.result.desk?.payloadLoaded).not.toBe(false);
		expect(full.result.detail?.payloadLoaded).not.toBe(false);
		expect(full.result.detail?.fixtures).toHaveLength(2);
	});

	it("rejects case-insensitive duplicate stat identifiers before serving detail", async () => {
		const redis = new TestRedis();
		const bundle = structuredClone(buildBundle().bundle);
		bundle.detail.previous = structuredClone(bundle.detail.active);
		if (bundle.detail.active.publication === null || bundle.detail.active.items[0] === undefined)
			throw new Error("missing active detail");
		const publication = JSON.parse(bundle.detail.active.publication) as {
			fixtures: Array<{
				fixtureId: number;
				key: string;
				count: number;
				bytes: number;
				sha256: string;
			}>;
			detail: { revision: string };
		};
		const first = publication.fixtures[0];
		if (!first) throw new Error("missing first detail descriptor");
		const invalidPlayers = [
			{
				...player(3),
				stats: [
					{ identifier: "bps", value: 30, awardedPoints: 1 },
					{ identifier: "BPS", value: 30, awardedPoints: 2 },
				],
			},
		];
		const payload = encode(invalidPlayers);
		const checksum = digest(invalidPlayers);
		const item = bundle.detail.active.items[0];
		const invalidDescriptor = {
			...first,
			count: invalidPlayers.length,
			bytes: Buffer.byteLength(payload, "utf8"),
			sha256: checksum,
			key: first.key.replace(/:[0-9a-f]{64}$/, `:${checksum}`),
		};
		publication.fixtures[0] = invalidDescriptor;
		publication.detail.revision = digest([
			{ fixtureId: 101, players: invalidPlayers },
			{ fixtureId: 102, players: [player(8)] },
		]);
		bundle.detail.active.items[0] = {
			...item,
			fixtureId: invalidDescriptor.fixtureId,
			key: invalidDescriptor.key,
			payload,
			metadata: itemMeta(invalidPlayers),
		};
		bundle.detail.active.publication = JSON.stringify(publication);
		bundle.detail.active.manifest = bundle.detail.active.publication;
		attachBundle(redis, bundle);

		const result = await readLiveMatchday(buildSnapshotContext(redis), 1);

		expect(result.desk).not.toBeNull();
		expect(result.detail?.servedFrom).toBe("REDIS_PREVIOUS");
		expect(result.detail?.publication.generation).toBe(12);
	});

	it("rejects retired stat fields before serving V3 detail", async () => {
		const redis = new TestRedis();
		const bundle = structuredClone(buildBundle().bundle);
		bundle.detail.previous = structuredClone(bundle.detail.active);
		if (bundle.detail.active.publication === null || bundle.detail.active.items[0] === undefined)
			throw new Error("missing active detail");
		const publication = JSON.parse(bundle.detail.active.publication) as {
			fixtures: Array<{
				fixtureId: number;
				key: string;
				count: number;
				bytes: number;
				sha256: string;
			}>;
			detail: { revision: string };
		};
		const first = publication.fixtures[0];
		if (!first) throw new Error("missing first detail descriptor");
		const invalidPlayers = [
			{
				...player(3),
				stats: [
					{
						identifier: "bps",
						value: 30,
						awardedPoints: 3,
						points: 3,
						pointsModification: 0,
					},
				],
			},
		];
		const payload = encode(invalidPlayers);
		const checksum = digest(invalidPlayers);
		const item = bundle.detail.active.items[0];
		const invalidDescriptor = {
			...first,
			count: invalidPlayers.length,
			bytes: Buffer.byteLength(payload, "utf8"),
			sha256: checksum,
			key: first.key.replace(/:[0-9a-f]{64}$/, `:${checksum}`),
		};
		publication.fixtures[0] = invalidDescriptor;
		publication.detail.revision = digest([
			{ fixtureId: 101, players: invalidPlayers },
			{ fixtureId: 102, players: [player(8)] },
		]);
		bundle.detail.active.items[0] = {
			...item,
			fixtureId: invalidDescriptor.fixtureId,
			key: invalidDescriptor.key,
			payload,
			metadata: itemMeta(invalidPlayers),
		};
		bundle.detail.active.publication = JSON.stringify(publication);
		bundle.detail.active.manifest = bundle.detail.active.publication;
		attachBundle(redis, bundle);

		const result = await readLiveMatchday(buildSnapshotContext(redis), 1);

		expect(result.desk).not.toBeNull();
		expect(result.detail?.servedFrom).toBe("REDIS_PREVIOUS");
		expect(result.detail?.publication.generation).toBe(12);
	});

	it("rejects retired player fields before serving V3 detail", async () => {
		const redis = new TestRedis();
		const bundle = structuredClone(buildBundle().bundle);
		bundle.detail.previous = structuredClone(bundle.detail.active);
		if (bundle.detail.active.publication === null || bundle.detail.active.items[0] === undefined)
			throw new Error("missing active detail");
		const publication = JSON.parse(bundle.detail.active.publication) as {
			fixtures: Array<{
				fixtureId: number;
				key: string;
				count: number;
				bytes: number;
				sha256: string;
			}>;
			detail: { revision: string };
		};
		const first = publication.fixtures[0];
		if (!first) throw new Error("missing first detail descriptor");
		const invalidPlayers = [{ ...player(3), retiredField: true }];
		const payload = encode(invalidPlayers);
		const checksum = digest(invalidPlayers);
		const item = bundle.detail.active.items[0];
		const invalidDescriptor = {
			...first,
			count: invalidPlayers.length,
			bytes: Buffer.byteLength(payload, "utf8"),
			sha256: checksum,
			key: first.key.replace(/:[0-9a-f]{64}$/, `:${checksum}`),
		};
		publication.fixtures[0] = invalidDescriptor;
		publication.detail.revision = digest([
			{ fixtureId: 101, players: invalidPlayers },
			{ fixtureId: 102, players: [player(8)] },
		]);
		bundle.detail.active.items[0] = {
			...item,
			fixtureId: invalidDescriptor.fixtureId,
			key: invalidDescriptor.key,
			payload,
			metadata: itemMeta(invalidPlayers),
		};
		bundle.detail.active.publication = JSON.stringify(publication);
		bundle.detail.active.manifest = bundle.detail.active.publication;
		attachBundle(redis, bundle);

		const result = await readLiveMatchday(buildSnapshotContext(redis), 1);

		expect(result.desk).not.toBeNull();
		expect(result.detail?.servedFrom).toBe("REDIS_PREVIOUS");
		expect(result.detail?.publication.generation).toBe(12);
	});

	it("rejects publication timestamps that GraphQL DateTime cannot serialize", async () => {
		const redis = new TestRedis();
		const bundle = structuredClone(buildBundle().bundle);
		if (bundle.desk.active.publication === null) throw new Error("missing active desk");
		const publication = JSON.parse(bundle.desk.active.publication) as {
			sourceCheckedAt: string;
		};
		publication.sourceCheckedAt = "2026-08-31";
		bundle.desk.active.publication = JSON.stringify(publication);
		attachBundle(redis, bundle);

		const result = await readLiveMatchday(buildSnapshotContext(redis), 1);

		expect(result.desk).toBeNull();
		expect(result.detail).toBeNull();
	});

	it("does not seed the active-event authority after an explicit event read", async () => {
		const redis = new TestRedis();
		const bundle = { ...buildBundle({ eventId: 2 }).bundle, eventId: 2 };
		let available = true;
		(redis as unknown as { eval: (...args: unknown[]) => Promise<string> }).eval = async () => {
			if (!available) throw new Error("redis unavailable");
			return JSON.stringify(bundle);
		};
		const context = buildSnapshotContext(redis, { databaseQuery: async () => ({ rows: [] }) });

		await readLiveMatchday(context, 2);
		available = false;

		const fallback = await readLiveMatchday(context);
		expect(fallback.eventId).toBeNull();
		expect(fallback.desk).toBeNull();
		expect(fallback.detail).toBeNull();
	});

	it("requires detail coverage for every started fixture", async () => {
		const redis = new TestRedis();
		const bundle = structuredClone(buildBundle().bundle);
		if (!bundle.detail.active.publication) throw new Error("missing detail publication");
		const publication = JSON.parse(bundle.detail.active.publication) as {
			fixtures: unknown[];
		};
		publication.fixtures = publication.fixtures.slice(0, 1);
		bundle.detail.active.publication = JSON.stringify(publication);
		bundle.detail.active.manifest = bundle.detail.active.publication;
		bundle.detail.active.items = bundle.detail.active.items.slice(0, 1);
		attachBundle(redis, bundle);

		const result = await readLiveMatchday(buildSnapshotContext(redis), 1);
		expect(result.desk).not.toBeNull();
		expect(result.detail).toBeNull();
	});

	it("rejects an empty detail fixture after its desk has started", async () => {
		const redis = new TestRedis();
		const bundle = structuredClone(buildBundle().bundle);
		const active = bundle.detail.active;
		if (active.publication === null || active.items[0] === undefined)
			throw new Error("missing active detail");
		const publication = JSON.parse(active.publication) as {
			fixtures: Array<{
				fixtureId: number;
				key: string;
				count: number;
				bytes: number;
				sha256: string;
			}>;
			detail: { revision: string };
		};
		const first = publication.fixtures[0];
		if (!first) throw new Error("missing first detail descriptor");
		const emptyPlayers: unknown[] = [];
		const emptyPayload = encode(emptyPlayers);
		const emptySha = digest(emptyPlayers);
		const emptyKey = first.key.replace(/:[0-9a-f]{64}$/, `:${emptySha}`);
		publication.fixtures[0] = {
			...first,
			key: emptyKey,
			count: 0,
			bytes: Buffer.byteLength(emptyPayload, "utf8"),
			sha256: emptySha,
		};
		active.items[0] = {
			...active.items[0],
			key: emptyKey,
			payload: emptyPayload,
			metadata: itemMeta(emptyPlayers),
		};
		publication.detail.revision = digest([
			{ fixtureId: 101, players: emptyPlayers },
			{ fixtureId: 102, players: [player(8)] },
		]);
		active.publication = JSON.stringify(publication);
		active.manifest = active.publication;
		attachBundle(redis, bundle);

		const result = await readLiveMatchday(buildSnapshotContext(redis), 1);

		expect(result.desk).not.toBeNull();
		expect(result.detail).toBeNull();
	});

	it("rejects a desk whose stream revisions do not match its payload", async () => {
		for (const revisionName of ["lifecycle", "fixtureIdentity", "scoreState"] as const) {
			const redis = new TestRedis();
			const bundle = structuredClone(buildBundle().bundle);
			if (bundle.desk.active.publication === null) throw new Error("missing active desk");
			const publication = JSON.parse(bundle.desk.active.publication) as {
				revisions: Record<string, { revision: string; contentUpdatedAt: string }>;
			};
			publication.revisions[revisionName] = {
				...publication.revisions[revisionName],
				revision: digest({ invalid: revisionName }),
			};
			bundle.desk.active.publication = JSON.stringify(publication);
			attachBundle(redis, bundle);

			const result = await readLiveMatchday(buildSnapshotContext(redis), 1);

			expect(result.desk).toBeNull();
			expect(result.detail).toBeNull();
		}
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
				reasonCodes: ["REDIS_CURRENT", "DETAIL_PENDING"],
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
		const bundle = structuredClone(buildBundle().bundle);
		bundle.desk.previous = structuredClone(bundle.desk.active);
		if (bundle.desk.active.publication === null) throw new Error("missing active desk");
		const activePublication = JSON.parse(bundle.desk.active.publication) as unknown as {
			desk: { count: number };
		};
		activePublication.desk.count = LIVE_MATCH_MAX_FIXTURES + 1;
		bundle.desk.active.publication = JSON.stringify(activePublication);
		attachBundle(redis, bundle);

		const result = await readLiveMatchday(buildSnapshotContext(redis), 1);

		expect(result.desk?.servedFrom).toBe("REDIS_PREVIOUS");
		expect(result.desk?.fixtures).toHaveLength(2);
	});

	it("falls back to previous detail when active points outside its namespace", async () => {
		const redis = new TestRedis();
		const bundle = structuredClone(buildBundle().bundle);
		bundle.detail.previous = structuredClone(bundle.detail.active);
		if (bundle.detail.active.publication === null) throw new Error("missing active detail");
		const activePublication = JSON.parse(bundle.detail.active.publication) as unknown as {
			fixtures: Array<{ key: string; sha256: string }>;
		};
		activePublication.fixtures[0].key = `llm:data:v2:fpl:other:${activePublication.fixtures[0].sha256}`;
		bundle.detail.active.publication = JSON.stringify(activePublication);
		bundle.detail.active.manifest = bundle.detail.active.publication;
		bundle.detail.active.items[0].key = activePublication.fixtures[0].key;
		attachBundle(redis, bundle);

		const result = await readLiveMatchday(buildSnapshotContext(redis), 1);

		expect(result.detail?.servedFrom).toBe("REDIS_PREVIOUS");
		expect(result.detail?.fixtures).toHaveLength(2);
	});

	it("labels a previous detail fallback independently from the desk", async () => {
		const redis = new TestRedis();
		const bundle = structuredClone(buildBundle().bundle);
		bundle.detail.previous = structuredClone(bundle.detail.active);
		if (bundle.detail.active.publication === null)
			throw new Error("missing active detail publication");
		const activePublication = JSON.parse(bundle.detail.active.publication) as unknown as {
			fixtures: Array<{ key: string; sha256: string }>;
		};
		activePublication.fixtures[0].key = `llm:data:v2:fpl:other:${activePublication.fixtures[0].sha256}`;
		bundle.detail.active.publication = JSON.stringify(activePublication);
		bundle.detail.active.manifest = bundle.detail.active.publication;
		bundle.detail.active.items[0].key = activePublication.fixtures[0].key;
		attachBundle(redis, bundle);

		const result = await graphql({
			schema,
			contextValue: buildSnapshotContext(redis),
			source: `query { liveMatchday(eventId: 1) { snapshot { detailDelivery { servedFrom reasonCodes } } } }`,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.liveMatchday).toMatchObject({
			snapshot: {
				detailDelivery: {
					servedFrom: "REDIS_PREVIOUS",
					reasonCodes: ["DETAIL_PREVIOUS", "DETAIL_METADATA_ONLY"],
				},
			},
		});
	});

	it("caps Redis detail fan-out before reading immutable item keys", () => {
		expect(LIVE_MATCHES_READ_POINTER_LUA).toContain(
			`#decoded.fixtures > ${LIVE_MATCH_MAX_FIXTURES}`
		);
		expect(LIVE_MATCHES_READ_POINTER_LUA).toContain(`total_bytes > ${2 * 1024 * 1024}`);
		expect(LIVE_MATCHES_READ_POINTER_LUA).not.toContain("manifest_decoded.fixtures");
		const detailScript = LIVE_MATCHES_READ_POINTER_LUA.slice(
			LIVE_MATCHES_READ_POINTER_LUA.indexOf("local function detail_candidate")
		);
		expect(detailScript.indexOf("local prefix =")).toBeLessThan(
			detailScript.indexOf("payload = read_string(item.key)")
		);
		expect(detailScript.indexOf('read_string(item.key .. ":meta")')).toBeLessThan(
			detailScript.indexOf("payload = read_string(item.key)")
		);
		expect(detailScript).toContain('if mode ~= "FULL" then');
		expect(detailScript.indexOf("redis_type(item.key)")).toBeLessThan(
			detailScript.indexOf('if mode ~= "FULL" then')
		);
		expect(detailScript.indexOf('if mode ~= "FULL" then')).toBeLessThan(
			detailScript.indexOf("payload = read_string(item.key)")
		);
		expect(detailScript).toContain("table.insert(items");
	});

	it("rejects a leading detail publication and keeps the desk available", async () => {
		const redis = new TestRedis();
		const built = buildBundle({ detailDeskGeneration: 3 });
		attachBundle(redis, built.bundle);
		const result = await readLiveMatchday(buildSnapshotContext(redis), 1);

		expect(result.desk?.servedFrom).toBe("REDIS_CURRENT");
		expect(result.detail).toBeNull();
	});

	it("tries previous detail when the active detail leads the served desk", async () => {
		const redis = new TestRedis();
		const built = buildBundle({ detailDeskGeneration: 3 });
		built.bundle.detail.previous = structuredClone(built.bundle.detail.active);
		if (built.bundle.detail.previous.publication === null) {
			throw new Error("missing previous detail");
		}
		const previousPublication = JSON.parse(built.bundle.detail.previous.publication) as {
			observedDeskGeneration: number;
		};
		previousPublication.observedDeskGeneration = 1;
		built.bundle.detail.previous.publication = JSON.stringify(previousPublication);
		built.bundle.detail.previous.manifest = built.bundle.detail.previous.publication;
		attachBundle(redis, built.bundle);

		const result = await readLiveMatchday(buildSnapshotContext(redis), 1);

		expect(result.desk?.servedFrom).toBe("REDIS_CURRENT");
		expect(result.detail?.servedFrom).toBe("REDIS_PREVIOUS");
	});

	it("rejects detail players outside the served fixture teams", async () => {
		const redis = new TestRedis();
		const bundle = structuredClone(buildBundle().bundle);
		const active = bundle.detail.active;
		if (active.publication === null || active.items[0] === undefined)
			throw new Error("missing active detail");
		const publication = JSON.parse(active.publication) as {
			fixtures: Array<{
				fixtureId: number;
				key: string;
				count: number;
				bytes: number;
				sha256: string;
			}>;
			detail: { revision: string };
		};
		const invalidPlayers = [{ ...player(3), teamId: 999 }];
		const payload = encode(invalidPlayers);
		const checksum = digest(invalidPlayers);
		const item = publication.fixtures[0];
		if (!item) throw new Error("missing first detail descriptor");
		const nextKey = item.key.replace(/:[0-9a-f]{64}$/, `:${checksum}`);
		publication.fixtures[0] = {
			...item,
			key: nextKey,
			bytes: Buffer.byteLength(payload, "utf8"),
			sha256: checksum,
		};
		active.items[0] = {
			...active.items[0],
			key: nextKey,
			payload,
			metadata: itemMeta(invalidPlayers),
		};
		publication.detail.revision = digest([
			{ fixtureId: 101, players: invalidPlayers },
			{ fixtureId: 102, players: [player(8)] },
		]);
		active.publication = JSON.stringify(publication);
		active.manifest = active.publication;
		attachBundle(redis, bundle);

		const result = await readLiveMatchday(buildSnapshotContext(redis), 1);

		expect(result.desk?.servedFrom).toBe("REDIS_CURRENT");
		expect(result.detail).toBeNull();
	});

	it("rejects detail players without a canonical price", async () => {
		const redis = new TestRedis();
		const bundle = structuredClone(buildBundle().bundle);
		const active = bundle.detail.active;
		if (active.publication === null || active.items[0] === undefined)
			throw new Error("missing active detail");
		const publication = JSON.parse(active.publication) as {
			fixtures: Array<{
				fixtureId: number;
				key: string;
				count: number;
				bytes: number;
				sha256: string;
			}>;
			detail: { revision: string };
		};
		const invalidPlayers = [{ ...player(3), price: undefined }];
		const payload = encode(invalidPlayers);
		const checksum = digest(invalidPlayers);
		const item = publication.fixtures[0];
		if (!item) throw new Error("missing first detail descriptor");
		const nextKey = item.key.replace(/:[0-9a-f]{64}$/, `:${checksum}`);
		publication.fixtures[0] = {
			...item,
			key: nextKey,
			bytes: Buffer.byteLength(payload, "utf8"),
			sha256: checksum,
		};
		active.items[0] = {
			...active.items[0],
			key: nextKey,
			payload,
			metadata: itemMeta(invalidPlayers),
		};
		publication.detail.revision = digest([
			{ fixtureId: 101, players: invalidPlayers },
			{ fixtureId: 102, players: [player(8)] },
		]);
		active.publication = JSON.stringify(publication);
		active.manifest = active.publication;
		attachBundle(redis, bundle);

		const result = await readLiveMatchday(buildSnapshotContext(redis), 1);

		expect(result.desk?.servedFrom).toBe("REDIS_CURRENT");
		expect(result.detail).toBeNull();
	});

	it("rejects detail that does not cover every desk fixture", async () => {
		const redis = new TestRedis();
		const bundle = structuredClone(buildBundle().bundle);
		const active = bundle.detail.active;
		if (active.publication === null) throw new Error("missing active detail");
		const publication = JSON.parse(active.publication) as {
			fixtures: Array<{ fixtureId: number }>;
			detail: { revision: string };
		};
		publication.fixtures.pop();
		active.items.pop();
		publication.detail.revision = digest([{ fixtureId: 101, players: [player(3)] }]);
		active.publication = JSON.stringify(publication);
		active.manifest = active.publication;
		attachBundle(redis, bundle);

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

	it("cools down a scoped detail miss when PostgreSQL has no valid desk row", async () => {
		const redis = new TestRedis();
		attachBundle(redis, buildBundle({ omitDetail: true }).bundle);
		let databaseReads = 0;
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => {
				databaseReads += 1;
				return { rows: [{ event_id: 1, desk: null, detail: null }] };
			},
		});

		const first = await readLiveMatchday(context, 1);
		const second = await readLiveMatchday(context, 1);

		expect(first.desk).not.toBeNull();
		expect(first.detail).toBeNull();
		expect(second.desk).not.toBeNull();
		expect(second.detail).toBeNull();
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

	it("serves the process LKG before attempting PostgreSQL after Redis loss", async () => {
		const redis = new TestRedis();
		const control = attachBundle(redis, buildBundle({ deskGeneration: 2 }).bundle);
		let databaseReads = 0;
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => {
				databaseReads += 1;
				return { rows: [] };
			},
		});

		const warm = await readLiveMatchday(context, 1);
		expect(warm.desk?.publication.generation).toBe(2);
		control.set(null);
		(redis as unknown as { eval: () => Promise<string> }).eval = async () => {
			throw new Error("redis unavailable");
		};

		const recovered = await readLiveMatchday(context, 1);

		expect(recovered.desk?.servedFrom).toBe("PROCESS_LKG");
		expect(recovered.desk?.publication.generation).toBe(2);
		expect(recovered.detail?.servedFrom).toBe("PROCESS_LKG");
		expect(databaseReads).toBe(0);
	});

	it("retains a complete Redis desk from a DESK read for process LKG", async () => {
		const redis = new TestRedis();
		const control = attachBundle(redis, buildBundle({ deskGeneration: 2 }).bundle);
		let databaseReads = 0;
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => {
				databaseReads += 1;
				throw new Error("DESK LKG recovery must not touch PostgreSQL");
			},
		});

		const first = await readLiveMatchday(context, 1, "DESK");
		expect(first.desk?.servedFrom).toBe("REDIS_CURRENT");
		expect(first.desk?.payloadLoaded).toBe(true);

		control.set(null);
		(redis as unknown as { eval: () => Promise<string> }).eval = async () => {
			throw new Error("redis unavailable");
		};
		const recovered = await readLiveMatchday(context, 1, "DESK");

		expect(recovered.desk?.servedFrom).toBe("PROCESS_LKG");
		expect(recovered.desk?.fixtures).toHaveLength(2);
		expect(databaseReads).toBe(0);
	});

	it("serves the cached active-event LKG during a Redis outage", async () => {
		const redis = new TestRedis();
		const control = attachBundle(redis, buildBundle({ eventId: 1 }).bundle);
		let databaseReads = 0;
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => {
				databaseReads += 1;
				return { rows: [] };
			},
		});

		const warm = await readLiveMatchday(context);
		expect(warm.eventId).toBe(1);
		control.set(null);
		(redis as unknown as { eval: () => Promise<string> }).eval = async () => {
			throw new Error("redis unavailable");
		};

		const recovered = await readLiveMatchday(context);
		const retained = await readLiveMatchday(context);

		expect(recovered.eventId).toBe(1);
		expect(recovered.desk?.servedFrom).toBe("PROCESS_LKG");
		expect(recovered.detail?.servedFrom).toBe("PROCESS_LKG");
		expect(recovered.redisRoundtrips).toBe(1);
		expect(retained.eventId).toBe(1);
		expect(retained.desk?.servedFrom).toBe("PROCESS_LKG");
		expect(retained.redisRoundtrips).toBe(1);
		expect(databaseReads).toBe(0);
		expect(LIVE_MATCH_ACTIVE_EVENT_REVALIDATION_MS).toBeGreaterThan(0);
	});

	it("revalidates PostgreSQL when Redis returns no active-event pointer", async () => {
		const redis = new TestRedis();
		const control = attachBundle(redis, buildBundle({ eventId: 1 }).bundle);
		let databaseReads = 0;
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => {
				databaseReads += 1;
				return { rows: [] };
			},
		});

		const warm = await readLiveMatchday(context);
		expect(warm.eventId).toBe(1);
		const missingPointer = structuredClone(buildBundle({ eventId: 1 }).bundle);
		missingPointer.eventId = null;
		missingPointer.desk.active = emptyDesk;
		missingPointer.desk.previous = emptyDesk;
		missingPointer.detail.active = emptyDetail;
		missingPointer.detail.previous = emptyDetail;
		control.set(missingPointer);

		const recovered = await readLiveMatchday(context);
		const retained = await readLiveMatchday(context);

		expect(recovered.eventId).toBe(1);
		expect(recovered.desk?.servedFrom).toBe("PROCESS_LKG");
		expect(recovered.detail?.servedFrom).toBe("PROCESS_LKG");
		expect(retained.eventId).toBe(1);
		expect(retained.desk?.servedFrom).toBe("PROCESS_LKG");
		expect(databaseReads).toBe(1);
	});

	it("discovers the newer active event from PostgreSQL after its Redis pointer disappears", async () => {
		const redis = new TestRedis();
		const control = attachBundle(redis, buildBundle({ eventId: 1 }).bundle);
		const newer = buildCheckpointRow({ eventId: 2 });
		let databaseReads = 0;
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => {
				databaseReads += 1;
				return { rows: [newer] };
			},
		});

		await readLiveMatchday(context);
		const missingPointer = structuredClone(buildBundle({ eventId: 1 }).bundle);
		missingPointer.eventId = null;
		missingPointer.desk.active = emptyDesk;
		missingPointer.desk.previous = emptyDesk;
		missingPointer.detail.active = emptyDetail;
		missingPointer.detail.previous = emptyDetail;
		control.set(missingPointer);

		const recovered = await readLiveMatchday(context);
		const retained = await readLiveMatchday(context);

		expect(recovered.eventId).toBe(2);
		expect(recovered.desk?.servedFrom).toBe("POSTGRES_CHECKPOINT");
		expect(retained.eventId).toBe(2);
		expect(retained.desk?.servedFrom).toBe("PROCESS_LKG");
		expect(databaseReads).toBe(1);
	});

	it("does not cache an invalid PostgreSQL active-event checkpoint as authority", async () => {
		const redis = new TestRedis();
		const control = attachBundle(redis, buildBundle({ eventId: 1 }).bundle);
		const invalid = buildCheckpointRow({ eventId: 2 });
		(invalid.desk as { publication_id: string }).publication_id = "invalid";
		let databaseReads = 0;
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => {
				databaseReads += 1;
				return { rows: [invalid] };
			},
		});

		const warm = await readLiveMatchday(context);
		expect(warm.eventId).toBe(1);
		const missingPointer = structuredClone(buildBundle({ eventId: 1 }).bundle);
		missingPointer.eventId = null;
		missingPointer.desk.active = emptyDesk;
		missingPointer.desk.previous = emptyDesk;
		missingPointer.detail.active = emptyDetail;
		missingPointer.detail.previous = emptyDetail;
		control.set(missingPointer);

		const recovered = await readLiveMatchday(context);
		const retained = await readLiveMatchday(context);

		expect(recovered.eventId).toBe(1);
		expect(recovered.desk?.servedFrom).toBe("PROCESS_LKG");
		expect(recovered.postgresReadFailed).toBe(true);
		expect(retained.eventId).toBe(1);
		expect(retained.desk?.servedFrom).toBe("PROCESS_LKG");
		expect(retained.postgresReadFailed).toBe(true);
		expect(databaseReads).toBe(1);
	});

	it("reuses a failed PostgreSQL checkpoint check after an eventless Redis pointer disappears", async () => {
		const redis = new TestRedis();
		const control = attachBundle(redis, buildBundle().bundle);
		const warmContext = buildSnapshotContext(redis, {
			databaseQuery: async () => {
				throw new Error("the warm metadata read must not touch PostgreSQL");
			},
		});

		await readLiveMatchday(warmContext, 1, "HEAD");
		const missingPointer = structuredClone(buildBundle().bundle);
		missingPointer.eventId = null;
		missingPointer.desk.active = emptyDesk;
		missingPointer.desk.previous = emptyDesk;
		missingPointer.detail.active = emptyDetail;
		missingPointer.detail.previous = emptyDetail;
		control.set(missingPointer);

		let databaseReads = 0;
		const failedContext = buildSnapshotContext(redis, {
			databaseQuery: async () => {
				databaseReads += 1;
				throw new Error("checkpoint unavailable");
			},
		});
		const first = await readLiveMatchday(failedContext);
		const second = await readLiveMatchday(failedContext);

		expect(first.desk).toBeNull();
		expect(second.desk).toBeNull();
		expect(first.postgresReadFailed).toBe(true);
		expect(second.postgresReadFailed).toBe(true);
		expect(databaseReads).toBe(1);
	});

	it("reuses the scoped checkpoint cooldown after Redis fails with a cached active event", async () => {
		const redis = new TestRedis();
		const control = attachBundle(redis, buildBundle({ eventId: 1 }).bundle);
		let databaseReads = 0;
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => {
				databaseReads += 1;
				return { rows: [] };
			},
		});

		const head = await readLiveMatchday(context, undefined, "HEAD");
		expect(head.eventId).toBe(1);
		control.set(null);
		(redis as unknown as { eval: () => Promise<string> }).eval = async () => {
			throw new Error("redis unavailable");
		};

		const firstFull = await readLiveMatchday(context, undefined, "FULL");
		const secondFull = await readLiveMatchday(context, undefined, "FULL");

		expect(firstFull.desk).toBeNull();
		expect(secondFull.desk).toBeNull();
		expect(firstFull.postgresReadFailed).toBe(false);
		expect(secondFull.postgresReadFailed).toBe(false);
		expect(databaseReads).toBe(1);
	});

	it("does not accept PostgreSQL detail metadata without a payload in HEAD reads", async () => {
		const redis = new TestRedis();
		(redis as unknown as { eval: () => Promise<string> }).eval = async () => {
			throw new Error("redis unavailable");
		};
		let databaseReads = 0;
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => {
				databaseReads += 1;
				return { rows: [buildCheckpointRow()] };
			},
		});

		const first = await readLiveMatchday(context, 1, "HEAD");
		const second = await readLiveMatchday(context, 1, "HEAD");

		expect(first.desk?.servedFrom).toBe("POSTGRES_CHECKPOINT");
		expect(first.desk?.payloadLoaded).toBe(false);
		expect(first.detail).toBeNull();
		expect(second.desk?.servedFrom).toBe("PROCESS_LKG");
		expect(second.detail).toBeNull();
		expect(second.desk?.payloadLoaded).toBe(false);
		expect(databaseReads).toBe(1);
	});

	it("does not share PostgreSQL revalidation cooldown across read modes", async () => {
		const redis = new TestRedis();
		(redis as unknown as { eval: () => Promise<string> }).eval = async () => {
			throw new Error("redis unavailable");
		};
		const queries: string[] = [];
		const context = buildSnapshotContext(redis, {
			databaseQuery: async (sql) => {
				queries.push(String(sql));
				return { rows: [buildCheckpointRow()] };
			},
		});

		const head = await readLiveMatchday(context, 1, "HEAD");
		const full = await readLiveMatchday(context, 1, "FULL");

		expect(head.desk?.servedFrom).toBe("POSTGRES_CHECKPOINT");
		expect(head.desk?.payloadLoaded).toBe(false);
		expect(full.desk?.servedFrom).toBe("POSTGRES_CHECKPOINT");
		expect(full.detail?.fixtures).toHaveLength(2);
		expect(queries).toEqual([LIVE_MATCH_CHECKPOINT_HEAD_SQL, LIVE_MATCH_CHECKPOINT_SQL]);
	});

	it("does not accept PostgreSQL detail metadata when Redis detail is absent", async () => {
		const redis = new TestRedis();
		const bundle = structuredClone(buildBundle().bundle);
		bundle.desk.active = emptyDesk;
		bundle.desk.previous = emptyDesk;
		bundle.detail.active = emptyDetail;
		bundle.detail.previous = emptyDetail;
		attachBundle(redis, bundle);
		let databaseReads = 0;
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => {
				databaseReads += 1;
				return { rows: [buildCheckpointRow()] };
			},
		});

		const first = await readLiveMatchday(context, 1, "HEAD");
		expect(first.desk?.servedFrom).toBe("POSTGRES_CHECKPOINT");
		expect(first.detail).toBeNull();

		(redis as unknown as { eval: () => Promise<string> }).eval = async () => {
			throw new Error("redis unavailable");
		};
		const recovered = await readLiveMatchday(context, 1, "HEAD");

		expect(recovered.desk?.servedFrom).toBe("PROCESS_LKG");
		expect(recovered.detail).toBeNull();
		expect(databaseReads).toBe(1);
	});

	it("does not replace a complete process LKG with a HEAD metadata read", async () => {
		const redis = new TestRedis();
		const control = attachBundle(redis, buildBundle().bundle);
		let databaseReads = 0;
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => {
				databaseReads += 1;
				throw new Error("complete process LKG must avoid PostgreSQL");
			},
		});

		const full = await readLiveMatchday(context, 1, "FULL");
		expect(full.detail?.fixtures).toHaveLength(2);
		const head = await readLiveMatchday(context, 1, "HEAD");
		expect(head.detail).toBeNull();
		expect(head.detailObservation?.payloadLoaded).toBe(false);

		control.set(null);
		(redis as unknown as { eval: () => Promise<string> }).eval = async () => {
			throw new Error("redis unavailable");
		};
		const recovered = await readLiveMatchday(context, 1, "FULL");

		expect(recovered.desk?.servedFrom).toBe("PROCESS_LKG");
		expect(recovered.detail?.servedFrom).toBe("PROCESS_LKG");
		expect(recovered.detail?.fixtures).toHaveLength(2);
		expect(databaseReads).toBe(0);
	});

	it("does not pair current detail metadata with a previous desk", async () => {
		const redis = new TestRedis();
		const bundle = structuredClone(buildBundle().bundle);
		bundle.desk.previous = structuredClone(bundle.desk.active);
		if (bundle.desk.active.publication === null) throw new Error("missing active desk");
		const activePublication = JSON.parse(bundle.desk.active.publication) as {
			desk: { count: number };
		};
		activePublication.desk.count = LIVE_MATCH_MAX_FIXTURES + 1;
		bundle.desk.active.publication = JSON.stringify(activePublication);
		const previousBundle = structuredClone(bundle);
		previousBundle.desk.active = structuredClone(previousBundle.desk.previous);
		previousBundle.detail.active = emptyDetail;
		previousBundle.detail.previous = emptyDetail;
		(redis as unknown as { eval: (...args: unknown[]) => Promise<string> }).eval = async (
			...args
		) => JSON.stringify(args.at(-2) === "previous" ? previousBundle : bundle);

		const result = await readLiveMatchday(buildSnapshotContext(redis), 1, "HEAD");

		expect(result.desk?.servedFrom).toBe("REDIS_PREVIOUS");
		expect(result.detail).toBeNull();
	});

	it("uses compatible previous detail metadata when the active manifest is incompatible", async () => {
		for (const mode of ["HEAD", "DESK"] as const) {
			resetLiveMatchProcessStateForTests();
			const redis = new TestRedis();
			const activeBundle = structuredClone(
				buildBundle({ deskGeneration: 2, detailGeneration: 12 }).bundle
			);
			const previousBundle = structuredClone(
				buildBundle({ deskGeneration: 1, detailGeneration: 11 }).bundle
			);
			if (!activeBundle.detail.active.publication)
				throw new Error("missing active detail publication");
			const activePublication = JSON.parse(activeBundle.detail.active.publication) as {
				fixtureIdentityRevision: string;
			};
			activePublication.fixtureIdentityRevision = "f".repeat(64);
			activeBundle.detail.active.publication = JSON.stringify(activePublication);
			activeBundle.detail.active.manifest = activeBundle.detail.active.publication;
			(redis as unknown as { eval: (...args: unknown[]) => Promise<string> }).eval = async (
				...args
			) => JSON.stringify(args.at(-2) === "previous" ? previousBundle : activeBundle);

			const result = await readLiveMatchday(buildSnapshotContext(redis), 1, mode);

			expect(result.desk?.servedFrom).toBe("REDIS_CURRENT");
			expect(result.detailObservation?.servedFrom).toBe("REDIS_PREVIOUS");
			expect(result.detailObservation?.publication.generation).toBe(11);
			expect(result.redisRoundtrips).toBe(2);
		}
	});

	it("keeps process LKG ahead of PostgreSQL on a Redis outage", async () => {
		const redis = new TestRedis();
		const control = attachBundle(
			redis,
			buildBundle({ deskGeneration: 2, detailGeneration: 12 }).bundle
		);
		let databaseReads = 0;
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => {
				databaseReads += 1;
				return { rows: [] };
			},
		});

		const warm = await readLiveMatchday(context);
		expect(warm.desk?.publication.generation).toBe(2);
		expect(warm.detail?.publication.generation).toBe(12);
		control.set(null);
		(redis as unknown as { eval: () => Promise<string> }).eval = async () => {
			throw new Error("redis unavailable");
		};

		const recovered = await readLiveMatchday(context);

		expect(recovered.desk?.publication.generation).toBe(2);
		expect(recovered.detail?.servedFrom).toBe("PROCESS_LKG");
		expect(recovered.detail?.publication.generation).toBe(12);
		expect(databaseReads).toBe(0);
	});

	it("does not let a newer PostgreSQL checkpoint displace process LKG", async () => {
		const redis = new TestRedis();
		const control = attachBundle(redis, buildBundle({ deskGeneration: 2 }).bundle);
		let databaseReads = 0;
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => {
				databaseReads += 1;
				return { rows: [] };
			},
		});

		const warm = await readLiveMatchday(context);
		expect(warm.desk?.publication.generation).toBe(2);
		control.set(null);
		(redis as unknown as { eval: () => Promise<string> }).eval = async () => {
			throw new Error("redis unavailable");
		};

		const recovered = await readLiveMatchday(context);

		expect(recovered.desk?.servedFrom).toBe("PROCESS_LKG");
		expect(recovered.desk?.publication.generation).toBe(2);
		expect(recovered.detail?.servedFrom).toBe("PROCESS_LKG");
		expect(databaseReads).toBe(0);
	});

	it("reserves the active event LKG from explicit historical reads", async () => {
		const redis = new TestRedis();
		const bundles = new Map(
			Array.from({ length: 10 }, (_, eventId) => {
				const bundle = buildBundle({ eventId }).bundle;
				return [eventId, { ...bundle, eventId }] as const;
			})
		);
		let available = true;
		(redis as unknown as { eval: (...args: unknown[]) => Promise<string> }).eval = async (
			...args
		) => {
			if (!available) throw new Error("redis unavailable");
			const rawEventId = args[args.length - 1];
			const eventId = rawEventId === "" ? 1 : Number(rawEventId);
			return JSON.stringify(bundles.get(eventId) ?? bundles.get(1));
		};
		const context = buildSnapshotContext(redis, { databaseQuery: async () => ({ rows: [] }) });

		const warm = await readLiveMatchday(context);
		expect(warm.eventId).toBe(1);
		for (let eventId = 2; eventId <= 9; eventId += 1) {
			const historical = await readLiveMatchday(context, eventId);
			expect(historical.eventId).toBe(eventId);
		}
		available = false;

		const retained = await readLiveMatchday(context);

		expect(retained.eventId).toBe(1);
		expect(retained.desk?.servedFrom).toBe("PROCESS_LKG");
		expect(retained.detail?.servedFrom).toBe("PROCESS_LKG");
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

	it("bounds checkpoint reads for an explicit event with a healthy Redis miss", async () => {
		const redis = new TestRedis();
		const bundle = structuredClone(buildBundle({ eventId: 999 }).bundle);
		bundle.desk.active = emptyDesk;
		bundle.desk.previous = emptyDesk;
		bundle.detail.active = emptyDetail;
		bundle.detail.previous = emptyDetail;
		attachBundle(redis, bundle);
		let databaseReads = 0;
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => {
				databaseReads += 1;
				return { rows: [] };
			},
		});

		const first = await readLiveMatchday(context, 999);
		const second = await readLiveMatchday(context, 999);

		expect(first.desk).toBeNull();
		expect(second.desk).toBeNull();
		expect(databaseReads).toBe(1);
	});

	it("keeps explicit event checkpoint cooldown state bounded", async () => {
		const redis = new TestRedis();
		(redis as unknown as { eval: () => Promise<string> }).eval = async () => {
			throw new Error("redis unavailable");
		};
		let databaseReads = 0;
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => {
				databaseReads += 1;
				return { rows: [] };
			},
		});

		for (let eventId = 1; eventId <= LIVE_MATCH_PROCESS_EVENT_CHECKED_AT_LIMIT + 1; eventId += 1) {
			await readLiveMatchday(context, eventId);
		}
		await readLiveMatchday(context, 1);

		expect(databaseReads).toBe(LIVE_MATCH_EXPLICIT_CHECKPOINT_MISS_BUDGET);
	});

	it("reserves the explicit checkpoint budget before concurrent miss reads", async () => {
		const redis = new TestRedis();
		(redis as unknown as { eval: () => Promise<string> }).eval = async () => {
			throw new Error("redis unavailable");
		};
		let databaseReads = 0;
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => {
				databaseReads += 1;
				await Promise.resolve();
				return { rows: [] };
			},
		});

		await Promise.all(
			Array.from({ length: LIVE_MATCH_PROCESS_EVENT_CHECKED_AT_LIMIT + 1 }, (_, index) =>
				readLiveMatchday(context, index + 1)
			)
		);

		expect(databaseReads).toBe(LIVE_MATCH_EXPLICIT_CHECKPOINT_MISS_BUDGET);
	});

	it("does not let explicit miss probes exhaust active-event recovery", async () => {
		const redis = new TestRedis();
		const activeBundle = structuredClone(buildBundle({ eventId: 1 }).bundle);
		activeBundle.desk.active = emptyDesk;
		activeBundle.desk.previous = emptyDesk;
		activeBundle.detail.active = emptyDetail;
		activeBundle.detail.previous = emptyDetail;
		(redis as unknown as { eval: (...args: unknown[]) => Promise<string> }).eval = async () =>
			JSON.stringify(activeBundle);
		let databaseReads = 0;
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => {
				databaseReads += 1;
				return databaseReads > LIVE_MATCH_EXPLICIT_CHECKPOINT_MISS_BUDGET
					? { rows: [buildCheckpointRow()] }
					: { rows: [] };
			},
		});

		for (let eventId = 2; eventId <= LIVE_MATCH_EXPLICIT_CHECKPOINT_MISS_BUDGET + 1; eventId += 1) {
			await readLiveMatchday(context, eventId);
		}
		const recovered = await readLiveMatchday(context);

		expect(recovered.eventId).toBe(1);
		expect(recovered.desk?.servedFrom).toBe("POSTGRES_CHECKPOINT");
		expect(databaseReads).toBe(LIVE_MATCH_EXPLICIT_CHECKPOINT_MISS_BUDGET + 1);
	});

	it("serves an exact self-contained PostgreSQL checkpoint when Redis is unavailable", async () => {
		const redis = new TestRedis();
		(redis as unknown as { eval: () => Promise<string> }).eval = async () => {
			throw new Error("redis unavailable");
		};
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => ({ rows: [buildCheckpointRow()] }),
		});

		const result = await readLiveMatchday(context, 1);

		expect(result.desk?.servedFrom).toBe("POSTGRES_CHECKPOINT");
		expect(result.detail?.servedFrom).toBe("POSTGRES_CHECKPOINT");
		expect(result.desk?.fixtures).toHaveLength(2);
		expect(result.detail?.fixtures).toHaveLength(2);
	});

	it("accepts PostgreSQL timestamps that represent the same instant", async () => {
		const redis = new TestRedis();
		(redis as unknown as { eval: () => Promise<string> }).eval = async () => {
			throw new Error("redis unavailable");
		};
		const row = buildCheckpointRow();
		const asPostgresTimestamp = (value: string): string => value.replace(".000Z", "+00:00");
		for (const checkpoint of [row.desk, row.detail]) {
			checkpoint.source_checked_at = asPostgresTimestamp(checkpoint.source_checked_at);
			checkpoint.published_at = asPostgresTimestamp(checkpoint.published_at);
			checkpoint.checkpointed_at =
				checkpoint.checkpointed_at === null
					? null
					: asPostgresTimestamp(checkpoint.checkpointed_at);
			checkpoint.expected_next_check_at = asPostgresTimestamp(checkpoint.expected_next_check_at);
			checkpoint.stale_at = asPostgresTimestamp(checkpoint.stale_at);
		}
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => ({ rows: [row] }),
		});

		const result = await readLiveMatchday(context, 1);

		expect(result.desk?.servedFrom).toBe("POSTGRES_CHECKPOINT");
		expect(result.detail?.servedFrom).toBe("POSTGRES_CHECKPOINT");
	});

	it("rejects a PostgreSQL HEAD checkpoint when its desk payload is corrupted", async () => {
		const redis = new TestRedis();
		(redis as unknown as { eval: () => Promise<string> }).eval = async () => {
			throw new Error("redis unavailable");
		};
		const row = buildCheckpointRow();
		row.desk.payload = [];
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => ({ rows: [row] }),
		});

		const result = await readLiveMatchday(context, 1, "HEAD");

		expect(result.desk).toBeNull();
		expect(result.detail).toBeNull();
	});

	it("rejects a PostgreSQL row whose manifest and columns are not the same publication", async () => {
		const redis = new TestRedis();
		(redis as unknown as { eval: () => Promise<string> }).eval = async () => {
			throw new Error("redis unavailable");
		};
		const row = buildCheckpointRow();
		row.desk.publication_id = publicationId(999);
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => ({ rows: [row] }),
		});

		const result = await readLiveMatchday(context, 1);

		expect(result.desk).toBeNull();
		expect(result.detail).toBeNull();
	});

	it("rejects a PostgreSQL detail checkpoint with retired fixture envelope fields", async () => {
		const redis = new TestRedis();
		(redis as unknown as { eval: () => Promise<string> }).eval = async () => {
			throw new Error("redis unavailable");
		};
		const row = buildCheckpointRow();
		const detailFixtures = structuredClone(row.detail.payload);
		const firstFixture = detailFixtures[0] as Record<string, unknown> | undefined;
		if (!firstFixture) throw new Error("missing detail fixture");
		firstFixture.retiredField = true;
		const detailRevision = { revision: digest(detailFixtures), contentUpdatedAt: later };
		row.detail.manifest = { ...row.detail.manifest, detail: detailRevision };
		row.detail.revisions = { detail: detailRevision };
		row.detail.payload = detailFixtures;
		row.detail.row_count = detailFixtures.length;
		row.detail.payload_bytes = Buffer.byteLength(encode(detailFixtures), "utf8");
		row.detail.payload_sha256 = detailRevision.revision;
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => ({ rows: [row] }),
		});

		const result = await readLiveMatchday(context, 1);

		expect(result.desk?.servedFrom).toBe("POSTGRES_CHECKPOINT");
		expect(result.detail).toBeNull();
	});

	it("rejects detail when the durable fixture envelope exceeds the shared byte limit", async () => {
		const redis = new TestRedis();
		(redis as unknown as { eval: () => Promise<string> }).eval = async () => {
			throw new Error("redis unavailable");
		};
		const row = buildCheckpointRow();
		const detailFixtures = Array.from({ length: 9 }, (_, index) => ({
			fixtureId: 500 + index,
			players: [
				{
					id: 20_000 + index,
					webName: "x".repeat(232_000),
					position: 3,
					teamId: 1,
					price: 55,
					totalPoints: 0,
					stats: [],
				},
			],
		}));
		const growth =
			LIVE_MATCH_MAX_DETAIL_TOTAL_BYTES - Buffer.byteLength(encode(detailFixtures), "utf8") + 1;
		if (growth <= 0) throw new Error("detail boundary fixture is invalid");
		detailFixtures[0]!.players[0]!.webName += "x".repeat(growth);
		const playerBytes = detailFixtures.reduce(
			(total, detail) => total + Buffer.byteLength(encode(detail.players), "utf8"),
			0
		);
		expect(playerBytes).toBeLessThanOrEqual(LIVE_MATCH_MAX_DETAIL_TOTAL_BYTES);
		expect(Buffer.byteLength(encode(detailFixtures), "utf8")).toBe(
			LIVE_MATCH_MAX_DETAIL_TOTAL_BYTES + 1
		);

		const deskFixtures = detailFixtures.map((detail, index) =>
			fixture(detail.fixtureId, 20 + index)
		);
		const fixtureIdentityRevision = deskFixtureIdentityDigest(deskFixtures);
		const deskManifest = {
			...row.desk.manifest,
			revisions: {
				...row.desk.manifest.revisions,
				fixtureIdentity: { revision: fixtureIdentityRevision, contentUpdatedAt: now },
				scoreState: {
					revision: deskScoreStateDigest(deskFixtures),
					contentUpdatedAt: later,
				},
			},
			desk: {
				...row.desk.manifest.desk,
				count: deskFixtures.length,
				bytes: Buffer.byteLength(encode(deskFixtures), "utf8"),
				sha256: digest(deskFixtures),
			},
		};
		row.desk.manifest = deskManifest;
		row.desk.revisions = deskManifest.revisions;
		row.desk.fixture_coverage = {
			fixture_ids: deskFixtures.map((fixture) => fixture.fixtureId),
			started_fixture_ids: deskFixtures.map((fixture) => fixture.fixtureId),
		};
		row.desk.payload = deskFixtures;
		row.desk.row_count = deskFixtures.length;
		row.desk.payload_bytes = Buffer.byteLength(encode(deskFixtures), "utf8");
		row.desk.payload_sha256 = digest(deskFixtures);

		const detailRevision = { revision: digest(detailFixtures), contentUpdatedAt: later };
		const detailManifest = {
			...row.detail.manifest,
			fixtureIdentityRevision,
			detail: detailRevision,
			fixtures: detailFixtures.map((detail) => {
				const checksum = digest(detail.players);
				return {
					fixtureId: detail.fixtureId,
					key: `llm:data:v3:fpl:live-match:detail:2627:1:${row.detail.generation}:${detail.fixtureId}:${checksum}`,
					type: "string",
					count: detail.players.length,
					bytes: Buffer.byteLength(encode(detail.players), "utf8"),
					sha256: checksum,
				};
			}),
		};
		row.detail.fixture_identity_revision = fixtureIdentityRevision;
		row.detail.manifest = detailManifest;
		row.detail.revisions = { detail: detailRevision };
		row.detail.payload = detailFixtures;
		row.detail.row_count = detailFixtures.length;
		row.detail.payload_bytes = Buffer.byteLength(encode(detailFixtures), "utf8");
		row.detail.payload_sha256 = detailRevision.revision;
		const context = buildSnapshotContext(redis, {
			databaseQuery: async () => ({ rows: [row] }),
		});

		const result = await readLiveMatchday(context, 1);

		expect(result.desk?.servedFrom).toBe("POSTGRES_CHECKPOINT");
		expect(result.detail).toBeNull();
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
			source: `query { liveMatchday(eventId: 1) { availability delivery { state reasonCodes } snapshot { detailDelivery { state } matches { fixtureId players { id } } } } }`,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.liveMatchday).toMatchObject({
			availability: "READY",
			delivery: { state: "FINAL" },
			snapshot: { detailDelivery: { state: "FINAL" } },
		});
	});

	it("does not report FINAL from a manifest-only HEAD", async () => {
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
			source: `query { liveMatchday(eventId: 1) { availability delivery { state reasonCodes } snapshot { detailDelivery { state reasonCodes } } } }`,
		});

		expect(result.errors).toBeUndefined();
		expect(result.data?.liveMatchday).toMatchObject({
			availability: "READY",
			delivery: {
				state: "DEGRADED",
				reasonCodes: ["REDIS_CURRENT", "DETAIL_OR_DESK_DEGRADED", "FINAL_CHECKPOINT_PENDING"],
			},
			snapshot: {
				detailDelivery: {
					state: "DEGRADED",
					reasonCodes: ["FINAL_CHECKPOINT_PENDING"],
				},
			},
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
				reasonCodes: ["REDIS_CURRENT", "DETAIL_OR_DESK_DEGRADED", "FINAL_CHECKPOINT_PENDING"],
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
