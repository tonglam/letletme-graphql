import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type Redis from "ioredis";
import type { GraphQLContext } from "../../src/graphql/context";
import type { QueryExecutor } from "../../src/infra/database";
import {
	activeDataPublicationKey,
	dataPublicationItemKey,
	type DataPublicationManifest,
} from "../../src/infra/data-publication";
import {
	PRICE_CHANGE_MAX_AGE_MS,
	PRICE_CHANGE_READY_MS,
	readPriceChangePredictions,
} from "../../src/infra/price-change-predictions-client";

class FakeRedis {
	private readonly values = new Map<string, string>();

	set(key: string, value: string): void {
		this.values.set(key, value);
	}

	remove(key: string): void {
		this.values.delete(key);
	}

	async get(key: string): Promise<string | null> {
		return this.values.get(key) ?? null;
	}

	async mget(...keys: string[]): Promise<(string | null)[]> {
		return keys.map((key) => this.values.get(key) ?? null);
	}
}

const canonicalJson = (value: unknown): string => {
	const canonicalize = (candidate: unknown): unknown => {
		if (Array.isArray(candidate)) return candidate.map(canonicalize);
		if (candidate !== null && typeof candidate === "object") {
			const record = candidate as Record<string, unknown>;
			return Object.fromEntries(
				Object.keys(record)
					.sort()
					.map((key) => [key, canonicalize(record[key])])
			);
		}
		return candidate;
	};
	return JSON.stringify(canonicalize(value));
};

const sha256 = async (value: string): Promise<string> => {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const validPlayer = {
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
	transfersInEvent: 1000,
	transfersOutEvent: 100,
	lockedUntil: null,
	calibrating: false,
	projections: [{ offset: 0, projectedPercent: 0.5, likelihood: 4 }],
};

async function createPublication(
	ageMs: number,
	publicationId = "11111111-1111-4111-8111-111111111111"
): Promise<{
	manifest: DataPublicationManifest;
	context: Record<string, unknown>;
	players: unknown[];
	redis: FakeRedis;
	items: Record<string, unknown>;
}> {
	const fetchedAt = new Date(Date.now() - ageMs).toISOString();
	const deadline = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
	const context = {
		schemaVersion: 1,
		source: "FPL_BOOTSTRAP",
		fetchedAt,
		staleAt: new Date(Date.parse(fetchedAt) + PRICE_CHANGE_READY_MS).toISOString(),
		hardExpiresAt: new Date(Date.parse(fetchedAt) + PRICE_CHANGE_MAX_AGE_MS).toISOString(),
		deadline,
		nextDeadlines: [deadline],
		expectedPlayerCount: 1,
		observedPlayerCount: 1,
	};
	const players = [validPlayer];
	const scope = { dataset: "fpl:price-changes" as const, seasonCode: "2026" };
	const items = { context, players };
	const manifestItems = await Promise.all(
		(Object.entries(items) as ["context" | "players", unknown][]).map(async ([name, value]) => {
			const payload = canonicalJson(value);
			return {
				name,
				key: dataPublicationItemKey(scope, 1, name),
				type: "string" as const,
				count: Array.isArray(value) ? value.length : Object.keys(value as object).length,
				bytes: Buffer.byteLength(payload, "utf8"),
				sha256: await sha256(payload),
			};
		})
	);
	const manifest: DataPublicationManifest = {
		dataset: "fpl:price-changes",
		seasonCode: "2026",
		eventId: null,
		revision: 1,
		publicationId,
		sourceCheckedAt: fetchedAt,
		publishedAt: new Date().toISOString(),
		state: "active",
		items: manifestItems,
	};
	const redis = new FakeRedis();
	redis.set(activeDataPublicationKey(scope), JSON.stringify(manifest));
	for (const item of manifestItems) redis.set(item.key, canonicalJson(items[item.name]));
	return { manifest, context, players, redis, items };
}

function makeContext(
	redis: FakeRedis,
	database: QueryExecutor,
	logger: GraphQLContext["logger"] = {
		warn: () => undefined,
	} as unknown as GraphQLContext["logger"]
): GraphQLContext {
	return {
		redis: redis as unknown as Redis,
		database,
		currentSeason: { seasonId: 2026, seasonCode: "2026" },
		logger,
	} as GraphQLContext;
}

function makeDatabase(
	publication: Awaited<ReturnType<typeof createPublication>>,
	mutate?: (rows: Array<Record<string, unknown>>) => void
): QueryExecutor {
	const authority = {
		publication_id: publication.manifest.publicationId,
		revision: String(publication.manifest.revision),
		manifest: publication.manifest,
	};
	const rows = publication.manifest.items.map((item) => ({
		item_name: item.name,
		item_count: item.count,
		checksum: item.sha256,
		payload: publication.items[item.name],
	}));
	mutate?.(rows);
	return {
		query: async (sql: string) => {
			if (sql.includes("dataset_publications")) return { rows: [authority] };
			return { rows };
		},
	} as QueryExecutor;
}

describe("price-change publication reader", () => {
	it("reads a valid Redis publication without touching PostgreSQL", async () => {
		const publication = await createPublication(9 * 60 * 1_000);
		let databaseCalls = 0;
		const database = {
			query: async () => {
				databaseCalls += 1;
				throw new Error("PostgreSQL should not be needed");
			},
		} as unknown as QueryExecutor;

		const board = await readPriceChangePredictions(makeContext(publication.redis, database));
		assert.equal(board.status, "READY");
		assert.equal(board.revision, publication.manifest.publicationId);
		assert.equal(board.players.length, 1);
		assert.equal(databaseCalls, 0);
	});

	it("falls back to the matching PostgreSQL publication when Redis is damaged", async () => {
		const publication = await createPublication(9 * 60 * 1_000);
		const playersItem = publication.manifest.items.find((item) => item.name === "players");
		publication.redis.set(playersItem!.key, "[]");

		const board = await readPriceChangePredictions(
			makeContext(publication.redis, makeDatabase(publication))
		);
		assert.equal(board.status, "READY");
		assert.equal(board.players[0]?.playerId, 1);
	});

	it("falls back to a fresh PostgreSQL publication when the Redis publication expired", async () => {
		const expiredRedisPublication = await createPublication(
			PRICE_CHANGE_MAX_AGE_MS + 1_000,
			"11111111-1111-4111-8111-111111111111"
		);
		const freshPostgresPublication = await createPublication(
			9 * 60 * 1_000,
			"22222222-2222-4222-8222-222222222222"
		);

		const board = await readPriceChangePredictions(
			makeContext(expiredRedisPublication.redis, makeDatabase(freshPostgresPublication))
		);
		assert.equal(board.status, "READY");
		assert.equal(board.revision, freshPostgresPublication.manifest.publicationId);
	});

	it("fails closed when PostgreSQL item checksum proof is wrong", async () => {
		const publication = await createPublication(9 * 60 * 1_000);
		publication.redis.remove(
			activeDataPublicationKey({ dataset: "fpl:price-changes", seasonCode: "2026" })
		);
		const database = makeDatabase(publication, (rows) => {
			rows[1]!.checksum = "0".repeat(64);
		});

		const board = await readPriceChangePredictions(makeContext(publication.redis, database));
		assert.equal(board.status, "UNAVAILABLE");
	});

	it("derives READY, STALE, and UNAVAILABLE from publication age", async () => {
		for (const [ageMs, expected] of [
			[9 * 60 * 1_000, "READY"],
			[PRICE_CHANGE_READY_MS + 1_000, "STALE"],
			[PRICE_CHANGE_MAX_AGE_MS + 1_000, "UNAVAILABLE"],
		] as const) {
			const publication = await createPublication(ageMs);
			publication.redis.remove(
				activeDataPublicationKey({ dataset: "fpl:price-changes", seasonCode: "2026" })
			);
			const board = await readPriceChangePredictions(
				makeContext(publication.redis, makeDatabase(publication))
			);
			assert.equal(board.status, expected);
		}
	});

	it("fails closed when fetchedAt is in the future", async () => {
		const publication = await createPublication(-1_000);
		const board = await readPriceChangePredictions(
			makeContext(publication.redis, makeDatabase(publication))
		);
		assert.equal(board.status, "UNAVAILABLE");
	});

	it("logs PostgreSQL fallback query failures", async () => {
		const publication = await createPublication(9 * 60 * 1_000);
		publication.redis.remove(
			activeDataPublicationKey({ dataset: "fpl:price-changes", seasonCode: "2026" })
		);
		const databaseError = new Error("database unavailable");
		const database = {
			query: async () => {
				throw databaseError;
			},
		} as unknown as QueryExecutor;
		let warning: { fields: Record<string, unknown>; message: string } | undefined;
		const logger = {
			warn: (fields: Record<string, unknown>, message: string) => {
				warning = { fields, message };
			},
		} as unknown as GraphQLContext["logger"];

		const board = await readPriceChangePredictions(
			makeContext(publication.redis, database, logger)
		);

		assert.equal(board.status, "UNAVAILABLE");
		assert.equal(warning?.fields.err, databaseError);
		assert.equal(warning?.fields.dataset, "fpl:price-changes");
		assert.equal(warning?.fields.seasonCode, "2026");
		assert.equal(warning?.message, "Failed to load price-change publication from PostgreSQL");
	});
});
