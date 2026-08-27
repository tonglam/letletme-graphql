import { createHash } from "crypto";
import type Redis from "ioredis";
import { isPlainRecord as isRecord } from "../contracts/guards";
import { hasExactFields } from "./exact-fields";

export const DATA_CACHE_NAMESPACE = "llm:data";

export type DataPublicationDataset = "fpl:core" | "fpl:live" | "fpl:market" | "fpl:price-changes";

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
	dataset: DataPublicationDataset;
	seasonCode: string;
	eventId: number | null;
	revision: number;
	publicationId: string;
	sourceCheckedAt: string;
	lastSuccessfulFetchAt?: string;
	freshnessWindowId?: number;
	freshnessWindowIds?: readonly number[];
	publishedAt: string;
	state: "active" | "scheduled" | "live" | "settled";
	items: readonly DataPublicationManifestItem[];
}>;

export type DataPublication = Readonly<{
	manifest: DataPublicationManifest;
	items: Readonly<Record<string, unknown>>;
}>;

export type DataPublicationRead = Readonly<{
	publication: DataPublication | null;
	observedManifest: DataPublicationManifest | null;
}>;

type CachedPublication = Readonly<{
	rawManifest: string;
	publication: DataPublication;
}>;

const publicationCache = new WeakMap<object, Map<string, CachedPublication>>();
const publicationReadFlights = new WeakMap<object, Map<string, Promise<DataPublicationRead>>>();

const MANIFEST_FIELDS = [
	"dataset",
	"seasonCode",
	"eventId",
	"revision",
	"publicationId",
	"sourceCheckedAt",
	"publishedAt",
	"state",
	"items",
] as const;
const OPTIONAL_MANIFEST_FIELDS = [
	"lastSuccessfulFetchAt",
	"freshnessWindowId",
	"freshnessWindowIds",
] as const;
const MANIFEST_ITEM_FIELDS = ["name", "key", "type", "count", "bytes", "sha256"] as const;

const hasManifestFields = (value: Record<string, unknown>): boolean => {
	const actual = Object.keys(value);
	const allowed = new Set<string>([...MANIFEST_FIELDS, ...OPTIONAL_MANIFEST_FIELDS]);
	return (
		MANIFEST_FIELDS.every((field) => actual.includes(field)) &&
		actual.every((field) => allowed.has(field))
	);
};
const DATASET_ITEM_NAMES: Record<DataPublicationDataset, readonly string[]> = {
	"fpl:core": [
		"events",
		"teams",
		"players",
		"phases",
		"fixtures",
		"currentEventId",
		"selectionRules",
	],
	"fpl:live": ["eventLive", "fixtures"],
	"fpl:market": ["context"],
	"fpl:price-changes": ["context", "players"],
};
const hasExactItemNames = (dataset: DataPublicationDataset, names: readonly string[]): boolean => {
	const actual = [...names].sort();
	const expected = [...DATASET_ITEM_NAMES[dataset]].sort();
	return (
		actual.length === expected.length && actual.every((name, index) => name === expected[index])
	);
};

const isCanonicalState = (
	dataset: DataPublicationDataset,
	state: unknown
): state is DataPublicationManifest["state"] => {
	if (dataset === "fpl:core" || dataset === "fpl:market" || dataset === "fpl:price-changes")
		return state === "active";
	return state === "scheduled" || state === "live" || state === "settled";
};

export const isDataPublicationId = (value: unknown): value is string =>
	typeof value === "string" &&
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const isIsoDate = (value: unknown): value is string =>
	typeof value === "string" && Number.isFinite(Date.parse(value));

const isPositiveSafeInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0;

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
		if (!isRecord(value) || !hasManifestFields(value)) return null;
		if (
			value.dataset !== "fpl:core" &&
			value.dataset !== "fpl:live" &&
			value.dataset !== "fpl:market" &&
			value.dataset !== "fpl:price-changes"
		)
			return null;
		const dataset = value.dataset;
		if (
			typeof value.seasonCode !== "string" ||
			!/^\d{4}$/.test(value.seasonCode) ||
			!isPositiveSafeInteger(value.revision) ||
			!isDataPublicationId(value.publicationId) ||
			!isIsoDate(value.sourceCheckedAt) ||
			(value.lastSuccessfulFetchAt !== undefined && !isIsoDate(value.lastSuccessfulFetchAt)) ||
			(value.freshnessWindowId !== undefined && !isPositiveSafeInteger(value.freshnessWindowId)) ||
			(value.freshnessWindowIds !== undefined &&
				(!Array.isArray(value.freshnessWindowIds) ||
					value.freshnessWindowIds.some((windowId) => !isPositiveSafeInteger(windowId)))) ||
			!isIsoDate(value.publishedAt) ||
			!isCanonicalState(dataset, value.state) ||
			!Array.isArray(value.items)
		) {
			return null;
		}

		const manifestScope: DataPublicationScope = {
			dataset,
			seasonCode: value.seasonCode,
			...(value.eventId === null ? {} : { eventId: value.eventId as number }),
		};
		assertScope(manifestScope);
		const revision = value.revision as number;
		const names = new Set<string>();
		for (const candidate of value.items) {
			if (!isRecord(candidate) || !hasExactFields(candidate, MANIFEST_ITEM_FIELDS)) return null;
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
		if (!hasExactItemNames(dataset, [...names])) return null;

		const manifest = value as DataPublicationManifest;
		if (scope && !matchesScope(manifest, scope)) return null;
		return manifest;
	} catch {
		return null;
	}
};

export const readDataPublicationManifest = async (
	redis: Redis,
	scope: DataPublicationScope
): Promise<DataPublicationManifest | null> => {
	assertScope(scope);
	try {
		return parseDataPublicationManifest(await redis.get(activeDataPublicationKey(scope)), scope);
	} catch {
		return null;
	}
};

const hasRequiredItems = (
	manifest: DataPublicationManifest,
	requiredItemNames: readonly string[]
): boolean => {
	const actual = new Set(manifest.items.map((item) => item.name));
	return requiredItemNames.every((name) => actual.has(name));
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

const getPublicationReadFlights = (redis: Redis): Map<string, Promise<DataPublicationRead>> => {
	const identity = redis as object;
	let flights = publicationReadFlights.get(identity);
	if (!flights) {
		flights = new Map();
		publicationReadFlights.set(identity, flights);
	}
	return flights;
};

const READ_PUBLICATION_ITEMS_SCRIPT = `
local raw_manifest = redis.call('GET', KEYS[1])
if not raw_manifest then
  return {}
end
local manifest = cjson.decode(raw_manifest)
local keys_by_name = {}
for _, item in ipairs(manifest.items or {}) do
  keys_by_name[item.name] = item.key
end
local payload_keys = {}
for _, name in ipairs(ARGV) do
  local key = keys_by_name[name]
  if not key then
    return {}
  end
  table.insert(payload_keys, key)
end
local payloads = redis.call('MGET', unpack(payload_keys))
local result = { raw_manifest }
for _, payload in ipairs(payloads) do
  table.insert(result, payload)
end
return result
`;

type PublicationPayloadRead = Readonly<{
	rawManifest: string;
	payloads: readonly (string | null)[];
}>;

const readPublicationPayloads = async (
	redis: Redis,
	activeKey: string,
	manifestScope: DataPublicationScope,
	requiredItemNames: readonly string[]
): Promise<PublicationPayloadRead | null> => {
	const evaluator = (
		redis as Redis & {
			eval?: (...args: unknown[]) => Promise<unknown>;
		}
	).eval;
	if (typeof evaluator === "function") {
		const result = await evaluator.call(
			redis,
			READ_PUBLICATION_ITEMS_SCRIPT,
			1,
			activeKey,
			...requiredItemNames
		);
		if (!Array.isArray(result) || typeof result[0] !== "string") return null;
		return {
			rawManifest: result[0],
			payloads: result.slice(1).map((value) => (typeof value === "string" ? value : null)),
		};
	}

	const rawManifest = await redis.get(activeKey);
	const manifest = parseDataPublicationManifest(rawManifest, manifestScope);
	if (!rawManifest || !manifest || !hasRequiredItems(manifest, requiredItemNames)) return null;
	const keys = requiredItemNames.map(
		(name) => manifest.items.find((item) => item.name === name)?.key ?? ""
	);
	if (keys.some((key) => key.length === 0)) return null;
	return { rawManifest, payloads: await redis.mget(...keys) };
};

const decodePublicationItems = (
	manifest: DataPublicationManifest,
	requiredItemNames: readonly string[],
	payloads: readonly (string | null)[]
): Record<string, unknown> | null => {
	if (payloads.length !== requiredItemNames.length) return null;
	const items: Record<string, unknown> = {};
	for (const [index, name] of requiredItemNames.entries()) {
		const item = manifest.items.find((candidate) => candidate.name === name);
		const payload = payloads[index];
		if (
			!item ||
			payload === null ||
			Buffer.byteLength(payload, "utf8") !== item.bytes ||
			sha256(payload) !== item.sha256
		) {
			return null;
		}
		try {
			const parsed: unknown = JSON.parse(payload);
			if (itemCount(parsed) !== item.count) return null;
			items[name] = parsed;
		} catch {
			return null;
		}
	}
	return items;
};

/**
 * Load immutable payload keys from a manifest already pinned by the caller.
 * This deliberately does not re-read the active pointer, so a request cannot
 * drift to a newer revision between a bounded manifest read and a full read.
 */
export const readDataPublicationItemsAtManifest = async (
	redis: Redis,
	manifest: DataPublicationManifest,
	requiredItemNames: readonly string[]
): Promise<DataPublication | null> => {
	const scope: DataPublicationScope = {
		dataset: manifest.dataset,
		seasonCode: manifest.seasonCode,
		...(manifest.eventId === null ? {} : { eventId: manifest.eventId }),
	};
	assertScope(scope);
	const uniqueItemNames = [...new Set(requiredItemNames)];
	if (uniqueItemNames.length === 0 || !hasRequiredItems(manifest, uniqueItemNames)) return null;

	try {
		const keys = uniqueItemNames.map(
			(name) => manifest.items.find((item) => item.name === name)?.key ?? ""
		);
		if (keys.some((key) => key.length === 0)) return null;
		const decoded = decodePublicationItems(manifest, uniqueItemNames, await redis.mget(...keys));
		return decoded ? { manifest, items: decoded } : null;
	} catch {
		return null;
	}
};

const readDataPublicationItemsObservedUncoalesced = async (
	redis: Redis,
	scope: DataPublicationScope,
	requiredItemNames: readonly string[]
): Promise<DataPublicationRead> => {
	const uniqueItemNames = requiredItemNames;
	const activeKey = activeDataPublicationKey(scope);
	const cache = getPublicationCache(redis);
	let observedManifest: DataPublicationManifest | null = null;
	try {
		const cached = cache.get(activeKey);
		if (cached) {
			const rawManifest = await redis.get(activeKey);
			const manifest = parseDataPublicationManifest(rawManifest, scope);
			if (!rawManifest || !manifest || !hasRequiredItems(manifest, uniqueItemNames)) {
				cache.delete(activeKey);
				return { publication: null, observedManifest: null };
			}
			observedManifest = manifest;
			const cachedItems = cached.rawManifest === rawManifest ? cached.publication.items : {};
			if (
				cached.rawManifest === rawManifest &&
				uniqueItemNames.every((name) => name in cachedItems)
			) {
				return { publication: cached.publication, observedManifest: manifest };
			}
		}

		const fetched = await readPublicationPayloads(redis, activeKey, scope, uniqueItemNames);
		if (!fetched) {
			cache.delete(activeKey);
			return { publication: null, observedManifest };
		}
		const manifest = parseDataPublicationManifest(fetched.rawManifest, scope);
		if (!manifest || !hasRequiredItems(manifest, uniqueItemNames)) {
			cache.delete(activeKey);
			return { publication: null, observedManifest };
		}
		observedManifest = manifest;
		const cachedItems =
			cache.get(activeKey)?.rawManifest === fetched.rawManifest
				? (cache.get(activeKey)?.publication.items ?? {})
				: {};
		const decoded = decodePublicationItems(manifest, uniqueItemNames, fetched.payloads);
		if (!decoded) {
			cache.delete(activeKey);
			return { publication: null, observedManifest: manifest };
		}
		const publication = {
			manifest,
			items: { ...cachedItems, ...decoded },
		} satisfies DataPublication;
		cache.set(activeKey, { rawManifest: fetched.rawManifest, publication });
		return { publication, observedManifest: manifest };
	} catch {
		cache.delete(activeKey);
		return { publication: null, observedManifest };
	}
};

export const readDataPublicationItemsObserved = (
	redis: Redis,
	scope: DataPublicationScope,
	requiredItemNames: readonly string[]
): Promise<DataPublicationRead> => {
	assertScope(scope);
	const uniqueItemNames = [...new Set(requiredItemNames)];
	if (uniqueItemNames.length === 0) {
		return Promise.resolve({ publication: null, observedManifest: null });
	}

	const activeKey = activeDataPublicationKey(scope);
	const flightKey = `${activeKey}\0${[...uniqueItemNames].sort().join("\0")}`;
	const flights = getPublicationReadFlights(redis);
	const existing = flights.get(flightKey);
	if (existing) return existing;

	const flight = readDataPublicationItemsObservedUncoalesced(redis, scope, uniqueItemNames);
	flights.set(flightKey, flight);
	const clearFlight = (): void => {
		if (flights.get(flightKey) === flight) flights.delete(flightKey);
	};
	void flight.then(clearFlight, clearFlight);
	return flight;
};

export const readDataPublicationItems = async (
	redis: Redis,
	scope: DataPublicationScope,
	requiredItemNames: readonly string[]
): Promise<DataPublication | null> =>
	(await readDataPublicationItemsObserved(redis, scope, requiredItemNames)).publication;

export const readDataPublication = readDataPublicationItems;
