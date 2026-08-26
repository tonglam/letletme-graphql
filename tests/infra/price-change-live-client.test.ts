import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import type Redis from "ioredis";
import type { GraphQLContext } from "../../src/graphql/context";
import type { QueryExecutor } from "../../src/infra/database";
import {
	activeDataPublicationKey,
	dataPublicationItemKey,
	type DataPublicationManifest,
} from "../../src/infra/data-publication";
import {
	readPriceChangeLiveBoard,
	readPriceChangeLiveCursor,
} from "../../src/infra/price-change-live-client";
import { readPriceChangePredictionsByPublicationId } from "../../src/infra/price-change-predictions-client";

const HOT_PREFIX = "fpl:price-changes:hot";
const seasonCode = "2026";

class FakeRedis {
	private readonly values = new Map<string, string>();
	readonly reads: string[] = [];

	set(key: string, value: unknown): void {
		this.values.set(key, typeof value === "string" ? value : JSON.stringify(value));
	}

	async get(key: string): Promise<string | null> {
		this.reads.push(key);
		return this.values.get(key) ?? null;
	}

	async mget(...keys: string[]): Promise<(string | null)[]> {
		return keys.map((key) => this.values.get(key) ?? null);
	}
}

const validBoard = (fetchedAt: string, revision = "abcdef0123456789") => ({
	status: "READY",
	source: "FPL_BOOTSTRAP",
	deadline: new Date(Date.parse(fetchedAt) + 60 * 60 * 1_000).toISOString(),
	nextDeadlines: [new Date(Date.parse(fetchedAt) + 60 * 60 * 1_000).toISOString()],
	fetchedAt,
	staleAt: new Date(Date.parse(fetchedAt) + 10 * 60 * 1_000).toISOString(),
	revision,
	expectedPlayerCount: 1,
	observedPlayerCount: 1,
	players: [
		{
			playerId: 1,
			playerCode: 101,
			webName: "Example",
			teamId: 1,
			teamName: "Example FC",
			teamShortName: "EXA",
			position: "MID",
			currentPrice: 100,
			selectedByPercent: 12.5,
			progressPercent: 75,
			hourlyRate: 0.5,
			status: "LIKELY_RISE",
			ownershipTrend: "UP",
			transfersInEvent: 1_000,
			transfersOutEvent: 100,
			lockedUntil: null,
			calibrating: false,
			projections: [{ offset: 0, projectedPercent: 0.5, likelihood: 4 }],
		},
	],
});

const canonicalJson = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
};

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

function durableFixture(ageMs: number, publicationId: string, revision: number) {
	const fetchedAt = new Date(Date.now() - ageMs).toISOString();
	const board = validBoard(fetchedAt, publicationId);
	const contextValue = {
		schemaVersion: 1,
		source: "FPL_BOOTSTRAP",
		fetchedAt,
		staleAt: board.staleAt,
		hardExpiresAt: new Date(Date.parse(fetchedAt) + 60 * 60 * 1_000).toISOString(),
		deadline: board.deadline,
		nextDeadlines: board.nextDeadlines,
		expectedPlayerCount: 1,
		observedPlayerCount: 1,
	};
	const items = { context: contextValue, players: board.players };
	const scope = { dataset: "fpl:price-changes" as const, seasonCode };
	const manifestItems = (Object.entries(items) as ["context" | "players", unknown][]).map(
		([name, value]) => {
			const payload = canonicalJson(value);
			return {
				name,
				key: dataPublicationItemKey(scope, revision, name),
				type: "string" as const,
				count: Array.isArray(value) ? value.length : Object.keys(value as object).length,
				bytes: Buffer.byteLength(payload, "utf8"),
				sha256: sha256(payload),
			};
		}
	);
	const manifest: DataPublicationManifest = {
		dataset: "fpl:price-changes",
		seasonCode,
		eventId: null,
		revision,
		publicationId,
		sourceCheckedAt: fetchedAt,
		publishedAt: new Date().toISOString(),
		state: "active",
		items: manifestItems,
	};
	return { manifest, items, board, hardExpiresAt: contextValue.hardExpiresAt };
}

function context(redis: FakeRedis, database?: QueryExecutor): GraphQLContext {
	return {
		redis: redis as unknown as Redis,
		database: database ?? ({ query: async () => ({ rows: [] }) } as unknown as QueryExecutor),
		currentSeason: { seasonId: 2026, seasonCode },
		logger: { warn: () => undefined } as unknown as GraphQLContext["logger"],
	} as GraphQLContext;
}

function publishHot(redis: FakeRedis, snapshot: Record<string, unknown>): void {
	const payloadKey = `${HOT_PREFIX}:${seasonCode}:${snapshot.revision}`;
	const metadataKey = `${payloadKey}:metadata`;
	redis.set(`${HOT_PREFIX}:${seasonCode}:active`, {
		revision: snapshot.revision,
		payloadKey,
		detectedAtMs: Date.parse(String(snapshot.detectedAt)),
	});
	redis.set(payloadKey, snapshot);
	const { board: _board, ...metadata } = snapshot;
	redis.set(metadataKey, metadata);
}

function hotSnapshot(ageMs = 1_000, revision = "abcdef0123456789"): Record<string, unknown> {
	const detectedAt = new Date(Date.now() - ageMs).toISOString();
	const board = validBoard(detectedAt, revision);
	return {
		schemaVersion: 1,
		seasonCode,
		revision: board.revision,
		triggerFingerprint: "a".repeat(64),
		sourceHash: "b".repeat(64),
		artifactId: "11111111-1111-4111-8111-111111111111",
		deadline: board.deadline,
		detectedAt,
		fetchedAt: detectedAt,
		expiresAt: new Date(Date.parse(detectedAt) + 15 * 60 * 1_000).toISOString(),
		expectedPlayerCount: 1,
		observedPlayerCount: 1,
		corePlayerCount: null,
		corePlayerDelta: null,
		board,
		reconciliation: {
			state: "pending",
			durablePublicationId: null,
			durableRevision: null,
			error: null,
		},
	};
}

describe("price-change live client", () => {
	it("returns a newer valid hot snapshot as provisional", async () => {
		const redis = new FakeRedis();
		const snapshot = hotSnapshot();
		publishHot(redis, snapshot);

		const liveCursor = await readPriceChangeLiveCursor(context(redis));
		assert.equal(liveCursor.state, "PROVISIONAL");
		assert.equal(liveCursor.revision, snapshot.revision);
		assert.ok(
			!redis.reads.includes(`${HOT_PREFIX}:${seasonCode}:${snapshot.revision}`),
			"cursor polling must not materialize the full hot board"
		);

		const liveBoard = await readPriceChangeLiveBoard(context(redis), snapshot.revision as string);
		assert.equal(liveBoard.state, "PROVISIONAL");
		assert.equal(liveBoard.board.players[0]?.currentPrice, 100);
	});

	it("fails closed for an expired or damaged hot payload", async () => {
		const expiredRedis = new FakeRedis();
		publishHot(expiredRedis, hotSnapshot(16 * 60 * 1_000));
		assert.equal((await readPriceChangeLiveCursor(context(expiredRedis))).state, "UNAVAILABLE");

		const damagedRedis = new FakeRedis();
		const snapshot = hotSnapshot();
		(snapshot.board as { expectedPlayerCount: number }).expectedPlayerCount = 2;
		(snapshot as { observedPlayerCount: number }).observedPlayerCount = 2;
		publishHot(damagedRedis, snapshot);
		assert.equal((await readPriceChangeLiveCursor(context(damagedRedis))).state, "UNAVAILABLE");
	});

	it("rejects metadata whose source is older than the durable maximum age", async () => {
		const redis = new FakeRedis();
		const snapshot = hotSnapshot();
		(snapshot as { fetchedAt: string }).fetchedAt = new Date(
			Date.now() - 61 * 60 * 1_000
		).toISOString();
		publishHot(redis, snapshot);

		assert.equal((await readPriceChangeLiveCursor(context(redis))).state, "UNAVAILABLE");
	});

	it("downgrades a hot board after its ready window", async () => {
		const redis = new FakeRedis();
		const snapshot = hotSnapshot(10 * 60 * 1_000 + 1_000);
		publishHot(redis, snapshot);

		const board = await readPriceChangeLiveBoard(context(redis));
		assert.equal(board.state, "PROVISIONAL");
		assert.equal(board.board.status, "STALE");
	});

	it("fails closed for malformed reconciliation metadata", async () => {
		const redis = new FakeRedis();
		const snapshot = hotSnapshot();
		snapshot.reconciliation = {
			state: "reconciled",
			durablePublicationId: "not-a-publication-id",
			durableRevision: 0,
			error: null,
		};
		publishHot(redis, snapshot);

		assert.equal((await readPriceChangeLiveCursor(context(redis))).state, "UNAVAILABLE");
	});

	it("fails closed for non-chronological hot deadlines", async () => {
		const redis = new FakeRedis();
		const snapshot = hotSnapshot();
		const deadline = String(snapshot.deadline);
		(snapshot.board as { nextDeadlines: string[] }).nextDeadlines = [deadline, deadline];
		(snapshot.board as { players: Array<{ projections: unknown[] }> }).players[0]!.projections = [
			{ offset: 0, projectedPercent: 0.5, likelihood: 4 },
			{ offset: 1, projectedPercent: 0.5, likelihood: 4 },
		];
		publishHot(redis, snapshot);

		assert.equal((await readPriceChangeLiveBoard(context(redis))).state, "UNAVAILABLE");
	});

	it("rejects a pointer that does not name its revision payload", async () => {
		const redis = new FakeRedis();
		const snapshot = hotSnapshot();
		redis.set(`${HOT_PREFIX}:${seasonCode}:active`, {
			revision: snapshot.revision,
			payloadKey: `${HOT_PREFIX}:${seasonCode}:other-revision`,
			detectedAtMs: Date.parse(String(snapshot.detectedAt)),
		});
		redis.set(`${HOT_PREFIX}:${seasonCode}:${snapshot.revision}`, snapshot);

		assert.equal((await readPriceChangeLiveCursor(context(redis))).state, "UNAVAILABLE");
	});

	it("pins a durable cursor to a retained publication after the active one advances", async () => {
		const redis = new FakeRedis();
		const current = durableFixture(8 * 60 * 1_000, "22222222-2222-4222-8222-222222222222", 2);
		redis.set(
			activeDataPublicationKey({ dataset: "fpl:price-changes", seasonCode }),
			JSON.stringify(current.manifest)
		);
		for (const item of current.manifest.items) {
			redis.set(item.key, canonicalJson(current.items[item.name as "context" | "players"]));
		}

		const retained = durableFixture(9 * 60 * 1_000, "11111111-1111-4111-8111-111111111111", 1);
		const database = {
			query: async (sql: string) => {
				if (sql.includes("FROM ops.dataset_publications") && sql.includes("publication_id = $1")) {
					return {
						rows: [
							{
								publication_id: retained.manifest.publicationId,
								revision: String(retained.manifest.revision),
								manifest: retained.manifest,
							},
						],
					};
				}
				if (sql.includes("FROM ops.dataset_publications")) return { rows: [] };
				return {
					rows: retained.manifest.items.map((item) => ({
						item_name: item.name,
						item_count: item.count,
						checksum: item.sha256,
						payload: retained.items[item.name as "context" | "players"],
					})),
				};
			},
		};

		const gqlContext = context(redis, database as unknown as QueryExecutor);
		const retainedBoard = await readPriceChangePredictionsByPublicationId(
			gqlContext,
			retained.manifest.publicationId
		);
		assert.ok(retainedBoard);
		const result = await readPriceChangeLiveBoard(gqlContext, retained.manifest.publicationId);
		assert.equal(result.revision, retained.manifest.publicationId);
		assert.equal(result.durablePublicationId, retained.manifest.publicationId);
		assert.equal(result.expiresAt, retained.hardExpiresAt);
	});

	it("serves the exact requested revision even after the active pointer advances", async () => {
		const redis = new FakeRedis();
		const oldSnapshot = hotSnapshot(1_000, "abcdef0123456789");
		const newerSnapshot = hotSnapshot(500, "0123456789abcdef");
		publishHot(redis, oldSnapshot);
		publishHot(redis, newerSnapshot);

		const board = await readPriceChangeLiveBoard(context(redis), "abcdef0123456789");
		assert.equal(board.revision, "abcdef0123456789");
		assert.equal(board.board.revision, "abcdef0123456789");
	});

	it("rejects an envelope whose board fetchedAt is not identical", async () => {
		const redis = new FakeRedis();
		const snapshot = hotSnapshot();
		(snapshot.board as { fetchedAt: string }).fetchedAt = new Date(
			Date.parse(String(snapshot.fetchedAt)) + 1
		).toISOString();
		publishHot(redis, snapshot);

		assert.equal((await readPriceChangeLiveBoard(context(redis))).state, "UNAVAILABLE");
	});

	it("returns unavailable without a durable or hot publication", async () => {
		const cursor = await readPriceChangeLiveCursor(context(new FakeRedis()));
		assert.deepEqual(cursor, {
			seasonCode,
			revision: null,
			state: "UNAVAILABLE",
			detectedAt: null,
			fetchedAt: null,
			expiresAt: null,
		});
	});

	it("falls back to durable cursor metadata from PostgreSQL without loading players", async () => {
		const redis = new FakeRedis();
		const durable = durableFixture(1_000, "11111111-1111-4111-8111-111111111111", 1);
		const queries: string[] = [];
		const database = {
			query: async (sql: string) => {
				queries.push(sql);
				if (sql.includes("FROM ops.dataset_publications")) {
					return {
						rows: [
							{
								publication_id: durable.manifest.publicationId,
								revision: String(durable.manifest.revision),
								manifest: durable.manifest,
							},
						],
					};
				}
				return {
					rows: [
						{
							item_name: "context",
							item_count: durable.manifest.items.find((item) => item.name === "context")?.count,
							checksum: durable.manifest.items.find((item) => item.name === "context")?.sha256,
							payload: durable.items.context,
						},
					],
				};
			},
		};

		const cursor = await readPriceChangeLiveCursor(
			context(redis, database as unknown as QueryExecutor)
		);
		assert.equal(cursor.state, "DURABLE");
		assert.equal(cursor.revision, durable.manifest.publicationId);
		assert.equal(queries.length, 2);
		assert.ok(queries[1]?.includes("item_name = 'context'"));
		assert.ok(!queries[1]?.includes("ORDER BY item_name"));
	});
});
