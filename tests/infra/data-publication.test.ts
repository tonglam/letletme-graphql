import { createHash } from "crypto";
import { describe, expect, it } from "bun:test";
import {
	activeDataPublicationKey,
	readDataPublication,
	type DataPublicationManifest,
} from "../../src/infra/data-publication";
import {
	createTestPublication,
	TestRedis,
	type TestPublication,
} from "../helpers/data-publication";

const scope = { dataset: "fpl:core" as const, seasonCode: "2627" };
const expectedItems = [
	"events",
	"teams",
	"players",
	"phases",
	"fixtures",
	"currentEventId",
] as const;

const publication = (): TestPublication =>
	createTestPublication(scope, 7, {
		events: [{ id: 1 }],
		teams: [{ id: 2 }],
		players: [],
		phases: [],
		fixtures: [],
		currentEventId: 1,
	});

type MutableManifestItem = Omit<
	{
		-readonly [
			Key in keyof DataPublicationManifest["items"][number]
		]: DataPublicationManifest["items"][number][Key];
	},
	"type"
> & { type: string };
type MutableManifest = Omit<
	{ -readonly [Key in keyof DataPublicationManifest]: DataPublicationManifest[Key] },
	"items"
> & { items: MutableManifestItem[] };

const replaceManifest = (
	redis: TestRedis,
	base: TestPublication,
	mutate: (manifest: MutableManifest) => unknown
): void => {
	const manifest: MutableManifest = {
		...base.manifest,
		items: base.manifest.items.map((item) => ({ ...item })),
	};
	mutate(manifest);
	redis.values.set(activeDataPublicationKey(scope), JSON.stringify(manifest));
};

describe("Data publication reader", () => {
	it("accepts one exact immutable revision and reuses it only while the pointer is unchanged", async () => {
		const first = publication();
		const redis = new TestRedis(first);
		let mgetCalls = 0;
		const originalMget = redis.mget;
		redis.mget = async (...keys: string[]) => {
			mgetCalls += 1;
			return originalMget(...keys);
		};

		const firstRead = await readDataPublication(redis as never, scope, expectedItems);
		const secondRead = await readDataPublication(redis as never, scope, expectedItems);

		expect(firstRead?.manifest.revision).toBe(7);
		expect(firstRead?.items.events).toEqual([{ id: 1 }]);
		expect(secondRead).toBe(firstRead);
		expect(mgetCalls).toBe(1);

		const next = createTestPublication(scope, 8, {
			events: [{ id: 3 }],
			teams: [{ id: 4 }],
			players: [],
			phases: [],
			fixtures: [],
			currentEventId: 1,
		});
		for (const [key, value] of next.store) redis.values.set(key, value);
		const nextRead = await readDataPublication(redis as never, scope, expectedItems);
		expect(nextRead?.manifest.revision).toBe(8);
		expect(nextRead?.items.events).toEqual([{ id: 3 }]);
		expect(mgetCalls).toBe(2);
	});

	it("coalesces concurrent reads of the same immutable item set", async () => {
		const base = publication();
		const redis = new TestRedis(base);
		let mgetCalls = 0;
		let getCalls = 0;
		let release!: () => void;
		let markStarted!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const originalGet = redis.get;
		const originalMget = redis.mget;
		redis.get = async (key: string) => {
			getCalls += 1;
			return originalGet(key);
		};
		redis.mget = async (...keys: string[]) => {
			mgetCalls += 1;
			markStarted();
			await gate;
			return originalMget(...keys);
		};

		const reads = Array.from({ length: 20 }, () =>
			readDataPublication(redis as never, scope, expectedItems)
		);
		await started;
		release();
		const results = await Promise.all(reads);

		expect(mgetCalls).toBe(1);
		expect(getCalls).toBe(1);
		expect(results.every((result) => result === results[0])).toBe(true);

		const cachedReads = await Promise.all(
			Array.from({ length: 20 }, () => readDataPublication(redis as never, scope, expectedItems))
		);
		expect(mgetCalls).toBe(1);
		expect(getCalls).toBe(2);
		expect(cachedReads.every((result) => result === results[0])).toBe(true);
	});

	it("loads only the requested items and fills the same cached revision on demand", async () => {
		const base = publication();
		const redis = new TestRedis(base);
		const requested: string[][] = [];
		const originalMget = redis.mget;
		redis.mget = async (...keys: string[]) => {
			requested.push(keys);
			return originalMget(...keys);
		};

		const fixtureOnly = await readDataPublication(redis as never, scope, ["teams", "fixtures"]);
		const complete = await readDataPublication(redis as never, scope, expectedItems);

		expect(fixtureOnly?.items.players).toBeUndefined();
		expect(fixtureOnly?.items.teams).toBeDefined();
		expect(fixtureOnly?.items.fixtures).toBeDefined();
		expect(complete?.items.players).toBeDefined();
		expect(requested).toHaveLength(2);
		expect(requested[0]?.every((key) => key.endsWith(":teams") || key.endsWith(":fixtures"))).toBe(
			true
		);
	});

	it("rejects wrong scope, missing/extra items, duplicate names, and noncanonical item keys", async () => {
		const cases: Array<(manifest: MutableManifest) => void> = [
			(manifest) => {
				(manifest as unknown as Record<string, unknown>).unexpected = true;
			},
			(manifest) => {
				manifest.seasonCode = "2526";
			},
			(manifest) => {
				manifest.items.pop();
			},
			(manifest) => {
				manifest.items.push({ ...manifest.items[0]!, name: "unknownItem" });
			},
			(manifest) => {
				manifest.items[1]!.name = "events";
			},
			(manifest) => {
				manifest.items[0]!.key = "llm:data:foreign";
			},
		];
		for (const mutate of cases) {
			const base = publication();
			const redis = new TestRedis(base);
			replaceManifest(redis, base, mutate);
			await expect(readDataPublication(redis as never, scope, expectedItems)).resolves.toBeNull();
		}
	});

	it("rejects missing payloads and mismatched bytes, hashes, counts, types, or JSON", async () => {
		const mutations: Array<{
			manifest?: (manifest: MutableManifest) => void;
			payload?: (redis: TestRedis, base: TestPublication) => void;
		}> = [
			{
				payload: (redis, base) => {
					redis.values.delete(base.manifest.items[0]!.key);
				},
			},
			{
				manifest: (manifest) => {
					manifest.items[0]!.bytes += 1;
				},
			},
			{
				manifest: (manifest) => {
					manifest.items[0]!.sha256 = "0".repeat(64);
				},
			},
			{
				manifest: (manifest) => {
					manifest.items[0]!.count += 1;
				},
			},
			{
				manifest: (manifest) => {
					manifest.items[0]!.type = "hash";
				},
			},
			{
				manifest: (manifest) => {
					const item = manifest.items[0]!;
					item.bytes = 1;
					item.sha256 = createHash("sha256").update("{").digest("hex");
					item.count = 1;
				},
				payload: (redis, base) => {
					redis.values.set(base.manifest.items[0]!.key, "{");
				},
			},
		];

		for (const mutation of mutations) {
			const base = publication();
			const redis = new TestRedis(base);
			mutation.payload?.(redis, base);
			if (mutation.manifest) replaceManifest(redis, base, mutation.manifest);
			await expect(readDataPublication(redis as never, scope, expectedItems)).resolves.toBeNull();
		}
	});

	it("rejects Redis command failures without returning a partial revision", async () => {
		const base = publication();
		const redis = new TestRedis(base);
		redis.mget = async () => {
			throw new Error("WRONGTYPE");
		};
		await expect(readDataPublication(redis as never, scope, expectedItems)).resolves.toBeNull();
	});
});
