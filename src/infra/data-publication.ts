import { createHash } from "crypto";
import type Redis from "ioredis";

export const DATA_CACHE_NAMESPACE = "llm:v3:data";
export const DATA_PUBLICATION_SCHEMA_VERSION = "v3";
export const DATA_PLATFORM_PLAN_VERSION = "3.2.5";

export type DataPublicationDataset = "fpl:core" | "fpl:live";

export type DataPublicationScope = Readonly<{
	dataset: DataPublicationDataset;
	seasonCode: string;
	eventId?: number;
}>;

export type DataPublicationManifestItem = Readonly<{
	name: string;
	key: string;
	type: "string";
	count: number;
	bytes: number;
	sha256: string;
}>;

export type DataPublicationManifest = Readonly<{
	schemaVersion: typeof DATA_PUBLICATION_SCHEMA_VERSION;
	planVersion: typeof DATA_PLATFORM_PLAN_VERSION;
	dataset: DataPublicationDataset;
	seasonCode: string;
	eventId: number | null;
	revision: number;
	publicationId: string;
	sourceCheckedAt: string;
	publishedAt: string;
	state?: string;
	items: readonly DataPublicationManifestItem[];
}>;

export type DataPublication = Readonly<{
	manifest: DataPublicationManifest;
	items: Readonly<Record<string, unknown>>;
}>;

type CachedPublication = Readonly<{
	rawManifest: string;
	publication: DataPublication;
}>;

const publicationCache = new WeakMap<object, Map<string, CachedPublication>>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const isDataPublicationId = (value: unknown): value is string =>
	typeof value === "string" &&
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const isIsoDate = (value: unknown): value is string =>
	typeof value === "string" && Number.isFinite(Date.parse(value));

const assertScope = (scope: DataPublicationScope): void => {
	if (!/^\d{4}$/.test(scope.seasonCode)) throw new Error("Invalid Data publication season");
	if (scope.dataset === "fpl:live") {
		if (!Number.isSafeInteger(scope.eventId) || (scope.eventId ?? 0) <= 0) {
			throw new Error("A live Data publication requires a positive event ID");
		}
		return;
	}
	if (scope.eventId !== undefined)
		throw new Error("A core Data publication cannot have an event ID");
};

const scopePrefix = (scope: DataPublicationScope): string => {
	assertScope(scope);
	return scope.dataset === "fpl:live"
		? `${DATA_CACHE_NAMESPACE}:${scope.dataset}:${scope.seasonCode}:${scope.eventId}`
		: `${DATA_CACHE_NAMESPACE}:${scope.dataset}:${scope.seasonCode}`;
};

export const activeDataPublicationKey = (scope: DataPublicationScope): string =>
	`${scopePrefix(scope)}:active`;

export const dataPublicationItemKey = (
	scope: DataPublicationScope,
	revision: number,
	itemName: string
): string => {
	if (!Number.isSafeInteger(revision) || revision <= 0) {
		throw new Error("Invalid Data publication revision");
	}
	if (!/^[a-z][a-zA-Z0-9]*$/.test(itemName)) {
		throw new Error(`Invalid Data publication item name: ${itemName}`);
	}
	return `${scopePrefix(scope)}:${revision}:${itemName}`;
};

const itemCount = (value: unknown): number => {
	if (Array.isArray(value)) return value.length;
	if (isRecord(value)) return Object.keys(value).length;
	return value === null || value === undefined ? 0 : 1;
};

const sha256 = (payload: string): string =>
	createHash("sha256").update(payload, "utf8").digest("hex");

const matchesScope = (manifest: DataPublicationManifest, scope: DataPublicationScope): boolean =>
	manifest.dataset === scope.dataset &&
	manifest.seasonCode === scope.seasonCode &&
	manifest.eventId === (scope.eventId ?? null);

export const parseDataPublicationManifest = (
	raw: string | null,
	scope?: DataPublicationScope
): DataPublicationManifest | null => {
	if (!raw) return null;
	try {
		const value: unknown = JSON.parse(raw);
		if (!isRecord(value)) return null;
		if (
			value.schemaVersion !== DATA_PUBLICATION_SCHEMA_VERSION ||
			value.planVersion !== DATA_PLATFORM_PLAN_VERSION ||
			(value.dataset !== "fpl:core" && value.dataset !== "fpl:live") ||
			typeof value.seasonCode !== "string" ||
			!/^\d{4}$/.test(value.seasonCode) ||
			!Number.isSafeInteger(value.revision) ||
			Number(value.revision) <= 0 ||
			!isDataPublicationId(value.publicationId) ||
			!isIsoDate(value.sourceCheckedAt) ||
			!isIsoDate(value.publishedAt) ||
			!Array.isArray(value.items)
		) {
			return null;
		}

		const manifestScope: DataPublicationScope = {
			dataset: value.dataset,
			seasonCode: value.seasonCode,
			...(value.eventId === null ? {} : { eventId: value.eventId as number }),
		};
		assertScope(manifestScope);
		const revision = value.revision as number;
		const names = new Set<string>();
		for (const candidate of value.items) {
			if (!isRecord(candidate)) return null;
			const name = candidate.name;
			if (
				typeof name !== "string" ||
				!/^[a-z][a-zA-Z0-9]*$/.test(name) ||
				names.has(name) ||
				candidate.type !== "string" ||
				candidate.key !== dataPublicationItemKey(manifestScope, revision, name) ||
				!Number.isInteger(candidate.count) ||
				Number(candidate.count) < 0 ||
				!Number.isInteger(candidate.bytes) ||
				Number(candidate.bytes) < 0 ||
				typeof candidate.sha256 !== "string" ||
				!/^[0-9a-f]{64}$/.test(candidate.sha256)
			) {
				return null;
			}
			names.add(name);
		}

		const manifest = value as DataPublicationManifest;
		if (scope && !matchesScope(manifest, scope)) return null;
		return manifest;
	} catch {
		return null;
	}
};

const hasExactItems = (
	manifest: DataPublicationManifest,
	expectedItemNames: readonly string[]
): boolean => {
	if (manifest.items.length !== expectedItemNames.length) return false;
	const actual = new Set(manifest.items.map((item) => item.name));
	return expectedItemNames.every((name) => actual.has(name));
};

const getPublicationCache = (redis: Redis): Map<string, CachedPublication> => {
	const identity = redis as object;
	let cache = publicationCache.get(identity);
	if (!cache) {
		cache = new Map();
		publicationCache.set(identity, cache);
	}
	return cache;
};

export const readDataPublication = async (
	redis: Redis,
	scope: DataPublicationScope,
	expectedItemNames: readonly string[]
): Promise<DataPublication | null> => {
	assertScope(scope);
	const activeKey = activeDataPublicationKey(scope);
	const cache = getPublicationCache(redis);
	try {
		const rawManifest = await redis.get(activeKey);
		const manifest = parseDataPublicationManifest(rawManifest, scope);
		if (!rawManifest || !manifest || !hasExactItems(manifest, expectedItemNames)) {
			cache.delete(activeKey);
			return null;
		}

		const cached = cache.get(activeKey);
		if (cached?.rawManifest === rawManifest) return cached.publication;

		const payloads = await redis.mget(...manifest.items.map((item) => item.key));
		const items: Record<string, unknown> = {};
		for (const [index, item] of manifest.items.entries()) {
			const payload = payloads[index];
			if (
				payload === null ||
				Buffer.byteLength(payload, "utf8") !== item.bytes ||
				sha256(payload) !== item.sha256
			) {
				cache.delete(activeKey);
				return null;
			}
			const parsed: unknown = JSON.parse(payload);
			if (itemCount(parsed) !== item.count) {
				cache.delete(activeKey);
				return null;
			}
			items[item.name] = parsed;
		}

		const publication = { manifest, items } satisfies DataPublication;
		cache.set(activeKey, { rawManifest, publication });
		return publication;
	} catch {
		cache.delete(activeKey);
		return null;
	}
};
