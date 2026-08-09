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
const expectedItems = ["events", "teams"] as const;

const publication = (): TestPublication =>
	createTestPublication(scope, 7, { events: [{ id: 1 }], teams: [{ id: 2 }] });

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
	"items" | "planVersion"
> & { items: MutableManifestItem[]; planVersion: string };

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
		});
		for (const [key, value] of next.store) redis.values.set(key, value);
		const nextRead = await readDataPublication(redis as never, scope, expectedItems);
		expect(nextRead?.manifest.revision).toBe(8);
		expect(nextRead?.items.events).toEqual([{ id: 3 }]);
		expect(mgetCalls).toBe(2);
	});

	it("rejects wrong scope, missing/extra items, duplicate names, and noncanonical item keys", async () => {
		const cases: Array<(manifest: MutableManifest) => void> = [
			(manifest) => {
				manifest.planVersion = "3.2.3";
			},
			(manifest) => {
				manifest.seasonCode = "2526";
			},
			(manifest) => {
				manifest.items.pop();
			},
			(manifest) => {
				manifest.items.push({ ...manifest.items[0]!, name: "players" });
			},
			(manifest) => {
				manifest.items[1]!.name = "events";
			},
			(manifest) => {
				manifest.items[0]!.key = "llm:v3:data:foreign";
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
