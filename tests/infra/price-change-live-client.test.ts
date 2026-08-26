import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type Redis from "ioredis";
import type { GraphQLContext } from "../../src/graphql/context";
import type { QueryExecutor } from "../../src/infra/database";
import {
	readPriceChangeLiveBoard,
	readPriceChangeLiveCursor,
} from "../../src/infra/price-change-live-client";

const HOT_PREFIX = "fpl:price-changes:hot";
const seasonCode = "2026";

class FakeRedis {
	private readonly values = new Map<string, string>();

	set(key: string, value: unknown): void {
		this.values.set(key, typeof value === "string" ? value : JSON.stringify(value));
	}

	async get(key: string): Promise<string | null> {
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

function context(redis: FakeRedis): GraphQLContext {
	return {
		redis: redis as unknown as Redis,
		database: { query: async () => ({ rows: [] }) } as unknown as QueryExecutor,
		currentSeason: { seasonId: 2026, seasonCode },
		logger: { warn: () => undefined } as unknown as GraphQLContext["logger"],
	} as GraphQLContext;
}

function publishHot(redis: FakeRedis, snapshot: Record<string, unknown>): void {
	const payloadKey = `${HOT_PREFIX}:${seasonCode}:${snapshot.revision}`;
	redis.set(`${HOT_PREFIX}:${seasonCode}:active`, {
		revision: snapshot.revision,
		payloadKey,
		detectedAtMs: Date.parse(String(snapshot.detectedAt)),
	});
	redis.set(payloadKey, snapshot);
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
		publishHot(damagedRedis, snapshot);
		assert.equal((await readPriceChangeLiveCursor(context(damagedRedis))).state, "UNAVAILABLE");
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

		assert.equal((await readPriceChangeLiveCursor(context(redis))).state, "UNAVAILABLE");
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

		assert.equal((await readPriceChangeLiveCursor(context(redis))).state, "UNAVAILABLE");
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
});
