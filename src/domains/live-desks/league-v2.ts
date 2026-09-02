import { createHash } from "node:crypto";

import type { DataSqlContractProbe } from "../../contracts/data-sql-contract";
import type { GraphQLContext } from "../../graphql/context";
import { isPublishedEntryLiveInputV2 } from "../entry-live/v2-service";

export type LeagueLiveScope = {
	season: string;
	eventId: number;
	tournamentId: number;
	mode: "CLASSIC";
};

export type LeagueLiveIndexRowV2 = {
	entryId: number;
	availability: "READY" | "NO_PICKS";
	entryName: string;
	playerName: string;
	region: string | null;
	startedEvent: number | null;
	overallPoints: number | null;
	overallRank: number | null;
	bank: number | null;
	teamValue: number | null;
	totalTransfers: number | null;
	lastEventId: number | null;
	lastOverallPoints: number | null;
	lastOverallRank: number | null;
	lastTeamValue: number | null;
	lastBank: number | null;
	inputPublicationId: string | null;
	inputGeneration: number | null;
	inputRevision: string | null;
	inputContentUpdatedAt: string | null;
};

type PublicationItem = {
	name: "index" | "payload";
	key: string;
	type: "string";
	count: number;
	bytes: number;
	sha256: string;
};

export type LeagueLiveManifestV2 = {
	contractVersion: "live-points-v2";
	publicationId: string;
	generation: number;
	season: string;
	eventId: number;
	tournamentId: number;
	scope: "CLASSIC";
	state:
		| "PRE_DEADLINE"
		| "PICKS_WAIT"
		| "PICKS_PROBE"
		| "PICKS_SYNC"
		| "LIVE_ACTIVE"
		| "BETWEEN_FIXTURES"
		| "DAY_SETTLING"
		| "GW_REVIEW"
		| "FINALIZED";
	globalRef: { publicationId: string; generation: number };
	revisions: {
		roster: string;
		scoreCore: string;
		fixtureIdentity: string;
		entryInputSet: string;
		identity: string;
		officialRank: string | null;
		rules: string;
		algorithm: string;
		schedule: string | null;
		averageSide: string | null;
		content: string;
	};
	times: {
		sourceCheckedAt: string;
		contentUpdatedAt: string;
		publishedAt: string;
		checkpointedAt: string | null;
		expectedNextCheckAt: string | null;
	};
	counts: { expected: number; published: number; ready: number; noPicks: number };
	items: { index: PublicationItem; payload: PublicationItem };
};

export type LeagueLivePublicationReadV2 = {
	publication: LeagueLiveManifestV2;
	index: readonly LeagueLiveIndexRowV2[];
	payload: Readonly<Record<string, unknown>>;
	servedFrom: "REDIS_CURRENT" | "REDIS_PREVIOUS" | "PROCESS_LKG" | "POSTGRES_CHECKPOINT";
};

export type LeagueLiveHeadReadV2 = {
	publication: LeagueLiveManifestV2;
	servedFrom: LeagueLivePublicationReadV2["servedFrom"];
};

const MAX_LEAGUE_ENTRIES = 5_000;
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_LKG_BYTES = 64 * 1024 * 1024;
const lkg = new Map<string, { value: LeagueLivePublicationReadV2; bytes: number }>();
let lkgBytes = 0;
const requestPublicationMemo = new WeakMap<
	object,
	Map<string, Promise<LeagueLivePublicationReadV2 | null>>
>();
type LeagueLiveLightReadV2 = {
	publication: LeagueLiveManifestV2;
	index: readonly LeagueLiveIndexRowV2[];
	servedFrom: LeagueLivePublicationReadV2["servedFrom"];
};
const requestLightMemo = new WeakMap<object, Map<string, Promise<LeagueLiveLightReadV2 | null>>>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const iso = (value: unknown): value is string =>
	typeof value === "string" && Number.isFinite(Date.parse(value));

const canonicalJson = (input: unknown): string => {
	if (Array.isArray(input)) return `[${input.map(canonicalJson).join(",")}]`;
	if (isRecord(input))
		return `{${Object.keys(input)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(input[key])}`)
			.join(",")}}`;
	return JSON.stringify(input) ?? "null";
};

const hash = (value: unknown): string =>
	createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");

const parseJson = (value: unknown): unknown => {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return null;
	}
};

const positiveInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const validHash = (value: unknown): value is string =>
	typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

const validItem = (
	value: unknown,
	expectedKey: string,
	name: PublicationItem["name"],
	maxBytes: number
): value is PublicationItem =>
	isRecord(value) &&
	value.name === name &&
	value.key === expectedKey &&
	value.type === "string" &&
	typeof value.count === "number" &&
	Number.isSafeInteger(value.count) &&
	value.count >= 0 &&
	typeof value.bytes === "number" &&
	Number.isSafeInteger(value.bytes) &&
	value.bytes >= 0 &&
	value.bytes <= maxBytes &&
	validHash(value.sha256);

const baseKey = (scope: LeagueLiveScope): string =>
	`llm:data:v2:fpl:league-live:${scope.season}:${scope.eventId}:${scope.tournamentId}:classic`;

const itemKey = (
	scope: LeagueLiveScope,
	generation: number,
	name: PublicationItem["name"]
): string => `${baseKey(scope)}:${generation}:${name}`;

const pointerKey = (scope: LeagueLiveScope, pointer: "active" | "previous"): string =>
	`${baseKey(scope)}:${pointer}`;

const scopeKey = (scope: LeagueLiveScope): string =>
	`${scope.season}:${scope.eventId}:${scope.tournamentId}:${scope.mode}`;

const parseManifest = (raw: unknown, scope: LeagueLiveScope): LeagueLiveManifestV2 | null => {
	const value = parseJson(raw);
	if (!isRecord(value)) return null;
	const generation = value.generation;
	const revisions = value.revisions;
	const times = value.times;
	const counts = value.counts;
	const globalRef = value.globalRef;
	if (!isRecord(revisions) || !isRecord(times) || !isRecord(counts) || !isRecord(globalRef))
		return null;
	const expected = counts.expected as number;
	if (
		value.contractVersion !== "live-points-v2" ||
		typeof value.publicationId !== "string" ||
		!/^[0-9a-f-]{36}$/i.test(value.publicationId) ||
		typeof generation !== "number" ||
		!Number.isSafeInteger(generation) ||
		generation <= 0 ||
		value.season !== scope.season ||
		value.eventId !== scope.eventId ||
		value.tournamentId !== scope.tournamentId ||
		value.scope !== "CLASSIC" ||
		![
			"PRE_DEADLINE",
			"PICKS_WAIT",
			"PICKS_PROBE",
			"PICKS_SYNC",
			"LIVE_ACTIVE",
			"BETWEEN_FIXTURES",
			"DAY_SETTLING",
			"GW_REVIEW",
			"FINALIZED",
		].includes(value.state as string) ||
		typeof globalRef.publicationId !== "string" ||
		!/^[0-9a-f-]{36}$/i.test(globalRef.publicationId) ||
		typeof globalRef.generation !== "number" ||
		!Number.isSafeInteger(globalRef.generation) ||
		globalRef.generation <= 0 ||
		![
			"roster",
			"scoreCore",
			"fixtureIdentity",
			"entryInputSet",
			"identity",
			"rules",
			"algorithm",
			"content",
		].every((key) => validHash(revisions[key])) ||
		!["officialRank", "schedule", "averageSide"].every(
			(key) =>
				Object.prototype.hasOwnProperty.call(revisions, key) &&
				(revisions[key] === null || validHash(revisions[key]))
		) ||
		!iso(times.sourceCheckedAt) ||
		!iso(times.contentUpdatedAt) ||
		!iso(times.publishedAt) ||
		(times.checkpointedAt !== null && !iso(times.checkpointedAt)) ||
		(times.expectedNextCheckAt !== null && !iso(times.expectedNextCheckAt)) ||
		!["expected", "published", "ready", "noPicks"].every(
			(key) =>
				typeof counts[key] === "number" && Number.isSafeInteger(counts[key]) && counts[key] >= 0
		) ||
		typeof counts.published !== "number" ||
		typeof counts.ready !== "number" ||
		typeof counts.noPicks !== "number" ||
		counts.published !== counts.ready + counts.noPicks ||
		counts.ready + counts.noPicks !== counts.expected ||
		!isRecord(value.items) ||
		expected > MAX_LEAGUE_ENTRIES ||
		!validItem(value.items.index, itemKey(scope, generation, "index"), "index", MAX_INDEX_BYTES) ||
		!validItem(
			value.items.payload,
			itemKey(scope, generation, "payload"),
			"payload",
			MAX_PAYLOAD_BYTES
		)
	)
		return null;
	return value as unknown as LeagueLiveManifestV2;
};

const validIndexRow = (value: unknown): value is LeagueLiveIndexRowV2 => {
	if (!isRecord(value)) return false;
	const nullableInt = (candidate: unknown, minimum?: number): boolean =>
		candidate === null ||
		(typeof candidate === "number" &&
			Number.isSafeInteger(candidate) &&
			(minimum === undefined || candidate >= minimum));
	return (
		positiveInteger(value.entryId) &&
		(value.availability === "READY" || value.availability === "NO_PICKS") &&
		typeof value.entryName === "string" &&
		value.entryName.length > 0 &&
		typeof value.playerName === "string" &&
		value.playerName.length > 0 &&
		(value.region === null || typeof value.region === "string") &&
		nullableInt(value.startedEvent, 1) &&
		nullableInt(value.overallPoints) &&
		nullableInt(value.overallRank, 1) &&
		nullableInt(value.bank, 0) &&
		nullableInt(value.teamValue, 0) &&
		nullableInt(value.totalTransfers, 0) &&
		nullableInt(value.lastEventId, 0) &&
		nullableInt(value.lastOverallPoints) &&
		nullableInt(value.lastOverallRank, 1) &&
		nullableInt(value.lastTeamValue, 0) &&
		nullableInt(value.lastBank, 0) &&
		(value.inputPublicationId === null ||
			(typeof value.inputPublicationId === "string" &&
				/^[0-9a-f-]{36}$/i.test(value.inputPublicationId))) &&
		(value.inputGeneration === null || nullableInt(value.inputGeneration, 1)) &&
		(value.inputRevision === null || validHash(value.inputRevision)) &&
		(value.inputContentUpdatedAt === null || iso(value.inputContentUpdatedAt))
	);
};

const validEntryInput = (
	value: unknown,
	row: LeagueLiveIndexRowV2,
	scope: LeagueLiveScope
): boolean => {
	if (
		!isRecord(value) ||
		!isPublishedEntryLiveInputV2(value, scope.season, scope.eventId, row.entryId)
	)
		return false;
	const picksBase = value.picksBase;
	if (
		value.contractVersion !== "live-points-v2" ||
		value.season !== scope.season ||
		value.eventId !== scope.eventId ||
		value.entryId !== row.entryId ||
		!isRecord(picksBase) ||
		!validHash(picksBase.revision) ||
		!iso(picksBase.contentUpdatedAt) ||
		!Array.isArray(picksBase.picks) ||
		picksBase.picks.length !== 15 ||
		!picksBase.picks.every(
			(pick) =>
				isRecord(pick) &&
				positiveInteger(pick.element) &&
				positiveInteger(pick.position) &&
				pick.position <= 15 &&
				typeof pick.multiplier === "number" &&
				Number.isSafeInteger(pick.multiplier) &&
				pick.multiplier >= 0 &&
				pick.multiplier <= 3 &&
				typeof pick.isCaptain === "boolean" &&
				typeof pick.isViceCaptain === "boolean" &&
				!(pick.isCaptain && pick.isViceCaptain)
		) ||
		new Set(picksBase.picks.map((pick) => (pick as Record<string, unknown>).element)).size !== 15 ||
		new Set(picksBase.picks.map((pick) => (pick as Record<string, unknown>).position)).size !==
			15 ||
		picksBase.picks.filter((pick) => isRecord(pick) && pick.isCaptain).length !== 1 ||
		picksBase.picks.filter((pick) => isRecord(pick) && pick.isViceCaptain).length !== 1 ||
		(picksBase.chip !== null && typeof picksBase.chip !== "string") ||
		typeof picksBase.transferCost !== "number" ||
		!Number.isSafeInteger(picksBase.transferCost) ||
		picksBase.transferCost < 0 ||
		leagueInputHash(value) !== row.inputRevision
	)
		return false;
	return true;
};

const leagueInputHash = (value: unknown): string => hash(value);

const validPublicationIndex = (
	value: unknown,
	publication: LeagueLiveManifestV2
): value is LeagueLiveIndexRowV2[] => {
	if (
		!Array.isArray(value) ||
		value.length !== publication.counts.expected ||
		value.length !== publication.items.index.count
	)
		return false;
	const ids = new Set<number>();
	let ready = 0;
	let noPicks = 0;
	for (const row of value) {
		if (
			!validIndexRow(row) ||
			ids.has(row.entryId) ||
			(row.overallRank !== null && publication.revisions.officialRank === null)
		)
			return false;
		ids.add(row.entryId);
		if (row.availability === "READY") ready++;
		else noPicks++;
	}
	return ready === publication.counts.ready && noPicks === publication.counts.noPicks;
};

const validPublicationPayload = (
	index: unknown,
	payload: unknown,
	publication: LeagueLiveManifestV2,
	scope: LeagueLiveScope
): index is LeagueLiveIndexRowV2[] => {
	if (!isRecord(payload) || !validPublicationIndex(index, publication)) return false;
	if (
		Object.keys(payload).length !== publication.items.payload.count ||
		Object.keys(payload).length !== index.length
	)
		return false;
	const ids = new Set<number>();
	for (const row of index) {
		ids.add(row.entryId);
		const value = payload[String(row.entryId)];
		if (row.availability === "READY") {
			if (
				row.inputPublicationId === null ||
				row.inputGeneration === null ||
				row.inputRevision === null ||
				row.inputContentUpdatedAt === null ||
				!validEntryInput(value, row, scope) ||
				!isRecord(value) ||
				(publication.state === "FINALIZED"
					? value.finalResult === null || value.finalResult === undefined
					: value.finalResult !== null)
			)
				return false;
		} else if (
			value !== null ||
			row.inputPublicationId !== null ||
			row.inputGeneration !== null ||
			row.inputRevision !== null ||
			row.inputContentUpdatedAt !== null
		)
			return false;
	}
	return Object.keys(payload).every((key) => /^\d+$/.test(key) && ids.has(Number(key)));
};

const readRedisPointer = async (
	context: GraphQLContext,
	scope: LeagueLiveScope,
	pointer: "active" | "previous"
): Promise<LeagueLivePublicationReadV2 | null> => {
	const raw = await context.redis.get(pointerKey(scope, pointer));
	const publication = parseManifest(raw, scope);
	if (!publication) return null;
	const values = await context.redis.mget(
		publication.items.index.key,
		publication.items.payload.key,
		`${publication.items.index.key}:meta`,
		`${publication.items.payload.key}:meta`
	);
	const [indexRaw, payloadRaw, indexMeta, payloadMeta] = values;
	if (
		indexRaw === null ||
		payloadRaw === null ||
		indexMeta !==
			`${publication.items.index.count}|${publication.items.index.bytes}|${publication.items.index.sha256}` ||
		payloadMeta !==
			`${publication.items.payload.count}|${publication.items.payload.bytes}|${publication.items.payload.sha256}` ||
		Buffer.byteLength(indexRaw, "utf8") !== publication.items.index.bytes ||
		Buffer.byteLength(payloadRaw, "utf8") !== publication.items.payload.bytes ||
		hash(parseJson(indexRaw)) !== publication.items.index.sha256 ||
		hash(parseJson(payloadRaw)) !== publication.items.payload.sha256
	)
		return null;
	const index = parseJson(indexRaw);
	const payload = parseJson(payloadRaw);
	if (!validPublicationPayload(index, payload, publication, scope)) return null;
	return {
		publication,
		index,
		payload: payload as Readonly<Record<string, unknown>>,
		servedFrom: pointer === "active" ? "REDIS_CURRENT" : "REDIS_PREVIOUS",
	};
};

/**
 * Head probes read the manifest, roster index and item metadata only. The
 * entry-input payload remains behind the full board read, so heartbeat-only
 * polls never pull or parse every embedded squad.
 */
const readRedisLightPointer = async (
	context: GraphQLContext,
	scope: LeagueLiveScope,
	pointer: "active" | "previous"
): Promise<LeagueLiveLightReadV2 | null> => {
	const raw = await context.redis.get(pointerKey(scope, pointer));
	const publication = parseManifest(raw, scope);
	if (!publication) return null;
	const [[indexRaw, indexMeta, payloadMeta], payloadBytes] = await Promise.all([
		context.redis.mget(
			publication.items.index.key,
			`${publication.items.index.key}:meta`,
			`${publication.items.payload.key}:meta`
		),
		context.redis.strlen(publication.items.payload.key),
	]);
	if (
		indexRaw === null ||
		indexMeta !==
			`${publication.items.index.count}|${publication.items.index.bytes}|${publication.items.index.sha256}` ||
		payloadMeta !==
			`${publication.items.payload.count}|${publication.items.payload.bytes}|${publication.items.payload.sha256}` ||
		payloadBytes !== publication.items.payload.bytes ||
		Buffer.byteLength(indexRaw, "utf8") !== publication.items.index.bytes ||
		hash(parseJson(indexRaw)) !== publication.items.index.sha256
	)
		return null;
	const index = parseJson(indexRaw);
	if (!validPublicationIndex(index, publication)) return null;
	return {
		publication,
		index,
		servedFrom: pointer === "active" ? "REDIS_CURRENT" : "REDIS_PREVIOUS",
	};
};

const remember = (scope: LeagueLiveScope, value: LeagueLivePublicationReadV2): void => {
	const bytes = Buffer.byteLength(canonicalJson(value), "utf8");
	const key = scopeKey(scope);
	const existing = lkg.get(key);
	if (existing) lkgBytes -= existing.bytes;
	lkg.delete(key);
	lkg.set(key, { value, bytes });
	lkgBytes += bytes;
	while (lkgBytes > MAX_LKG_BYTES && lkg.size > 0) {
		const first = lkg.keys().next().value as string | undefined;
		if (!first) break;
		const removed = lkg.get(first);
		lkg.delete(first);
		if (removed) lkgBytes -= removed.bytes;
	}
};

const readRemembered = (key: string): LeagueLivePublicationReadV2 | null => {
	const cached = lkg.get(key);
	if (!cached) return null;
	// Map insertion order is the LRU order. Touch a hit before returning it so
	// frequently used tournament scopes are evicted last.
	lkg.delete(key);
	lkg.set(key, cached);
	return cached.value;
};

const readCheckpoint = async (
	context: GraphQLContext,
	scope: LeagueLiveScope,
	expectedGlobal?: { publicationId: string; generation: number }
): Promise<LeagueLivePublicationReadV2 | null> => {
	try {
		const result = await context.database.query<Record<string, unknown>>(
			LIVE_LEAGUE_CHECKPOINT_SQL,
			[context.currentSeason.seasonId, scope.eventId, scope.tournamentId, "CLASSIC"]
		);
		const row = result.rows[0];
		if (!row) return null;
		const index = parseJson(row.index_payload);
		const payload = parseJson(row.payload);
		const publication = parseManifest(row.manifest, scope);
		if (
			!publication ||
			(expectedGlobal !== undefined &&
				(publication.globalRef.publicationId !== expectedGlobal.publicationId ||
					publication.globalRef.generation !== expectedGlobal.generation)) ||
			!validPublicationPayload(index, payload, publication, scope)
		)
			return null;
		const packed = { index, payload };
		if (
			publication.items.index.bytes !== Buffer.byteLength(canonicalJson(index), "utf8") ||
			publication.items.index.sha256 !== hash(index) ||
			publication.items.payload.bytes !== Buffer.byteLength(canonicalJson(payload), "utf8") ||
			publication.items.payload.sha256 !== hash(payload) ||
			row.payload_sha256 !== hash(packed) ||
			row.payload_bytes !== Buffer.byteLength(canonicalJson(packed), "utf8") ||
			row.row_count !== (index as unknown[]).length
		)
			return null;
		return {
			publication,
			index,
			payload: payload as Readonly<Record<string, unknown>>,
			servedFrom: "POSTGRES_CHECKPOINT",
		};
	} catch (error) {
		context.logger.warn(
			{ err: error, eventId: scope.eventId, tournamentId: scope.tournamentId },
			"Live league checkpoint read unavailable"
		);
		return null;
	}
};

const readLeagueLivePublicationUnmemoized = async (
	context: GraphQLContext,
	scope: LeagueLiveScope,
	expectedGlobal?: { publicationId: string; generation: number }
): Promise<LeagueLivePublicationReadV2 | null> => {
	for (const pointer of ["active", "previous"] as const) {
		try {
			const value = await readRedisPointer(context, scope, pointer);
			if (
				value &&
				(expectedGlobal === undefined ||
					(value.publication.globalRef.publicationId === expectedGlobal.publicationId &&
						value.publication.globalRef.generation === expectedGlobal.generation))
			) {
				remember(scope, value);
				return value;
			}
		} catch (error) {
			context.logger.warn(
				{ err: error, eventId: scope.eventId, tournamentId: scope.tournamentId, pointer },
				"Live league Redis read unavailable"
			);
		}
	}
	const cached = readRemembered(scopeKey(scope));
	if (
		cached &&
		(expectedGlobal === undefined ||
			(cached.publication.globalRef.publicationId === expectedGlobal.publicationId &&
				cached.publication.globalRef.generation === expectedGlobal.generation))
	)
		return { ...cached, servedFrom: "PROCESS_LKG" };
	return readCheckpoint(context, scope, expectedGlobal);
};

export const readLeagueLivePublicationV2 = (
	context: GraphQLContext,
	scope: LeagueLiveScope,
	expectedGlobal?: { publicationId: string; generation: number }
): Promise<LeagueLivePublicationReadV2 | null> => {
	let memo = requestPublicationMemo.get(context);
	if (!memo) {
		memo = new Map();
		requestPublicationMemo.set(context, memo);
	}
	const expectedKey = expectedGlobal
		? `:${expectedGlobal.publicationId}:${expectedGlobal.generation}`
		: "";
	const key = `${scopeKey(scope)}${expectedKey}`;
	const existing = memo.get(key);
	if (existing) return existing;
	const base = expectedGlobal ? memo.get(scopeKey(scope)) : undefined;
	const load = base
		? base.then((value) => {
				if (
					value &&
					expectedGlobal !== undefined &&
					value.publication.globalRef.publicationId === expectedGlobal.publicationId &&
					value.publication.globalRef.generation === expectedGlobal.generation
				)
					return value;
				return readLeagueLivePublicationUnmemoized(context, scope, expectedGlobal);
			})
		: readLeagueLivePublicationUnmemoized(context, scope, expectedGlobal);
	memo.set(key, load);
	return load;
};

const readLeagueLiveLightV2 = async (
	context: GraphQLContext,
	scope: LeagueLiveScope
): Promise<LeagueLiveLightReadV2 | null> => {
	let memo = requestLightMemo.get(context);
	if (!memo) {
		memo = new Map();
		requestLightMemo.set(context, memo);
	}
	const key = scopeKey(scope);
	const existing = memo.get(key);
	if (existing) return existing;
	const load = (async (): Promise<LeagueLiveLightReadV2 | null> => {
		for (const pointer of ["active", "previous"] as const) {
			try {
				const value = await readRedisLightPointer(context, scope, pointer);
				if (value) return value;
			} catch (error) {
				context.logger.warn(
					{ err: error, eventId: scope.eventId, tournamentId: scope.tournamentId, pointer },
					"Live league light Redis read unavailable"
				);
			}
		}
		const cached = readRemembered(scopeKey(scope));
		if (cached) {
			return {
				publication: cached.publication,
				index: cached.index,
				servedFrom: "PROCESS_LKG",
			};
		}
		const complete = await readLeagueLivePublicationV2(context, scope);
		return complete
			? {
					publication: complete.publication,
					index: complete.index,
					servedFrom: complete.servedFrom,
				}
			: null;
	})();
	memo.set(key, load);
	return load;
};

const readHead = async (
	context: GraphQLContext,
	scope: LeagueLiveScope
): Promise<LeagueLiveHeadReadV2 | null> => {
	const light = await readLeagueLiveLightV2(context, scope);
	return light ? { publication: light.publication, servedFrom: light.servedFrom } : null;
};

export const readLeagueLivePublicationPointerV2 = async (
	context: GraphQLContext,
	scope: LeagueLiveScope,
	pointer: "active" | "previous"
): Promise<LeagueLivePublicationReadV2 | null> => {
	try {
		const value = await readRedisPointer(context, scope, pointer);
		if (value) remember(scope, value);
		return value;
	} catch (error) {
		context.logger.warn(
			{ err: error, eventId: scope.eventId, tournamentId: scope.tournamentId, pointer },
			"Live league publication pointer read unavailable"
		);
		return null;
	}
};

export const readLeagueLiveHeadV2 = async (
	context: GraphQLContext,
	scope: LeagueLiveScope
): Promise<LeagueLiveHeadReadV2 | null> => {
	try {
		return await readHead(context, scope);
	} catch (error) {
		context.logger.warn(
			{ err: error, eventId: scope.eventId, tournamentId: scope.tournamentId },
			"Live league head read unavailable"
		);
		return null;
	}
};

/**
 * Authorizes a live head probe from the immutable roster index.  The same
 * request-scoped light publication read is reused by the later head/board
 * path, so authorization does not issue a second Redis read. `null` means that
 * no coherent roster index was available and the caller may use its narrow
 * durable authorization fallback.
 */
export const readLeagueLivePublicationMembershipV2 = async (
	context: GraphQLContext,
	scope: LeagueLiveScope,
	entryId: number
): Promise<boolean | null> => {
	try {
		const light = await readLeagueLiveLightV2(context, scope);
		return light ? light.index.some((row) => row.entryId === entryId) : null;
	} catch (error) {
		context.logger.warn(
			{ err: error, eventId: scope.eventId, tournamentId: scope.tournamentId },
			"Live league roster authorization fallback unavailable"
		);
		return null;
	}
};

const freshness = (publication: LeagueLiveManifestV2, now = Date.now()) => {
	const source = Date.parse(publication.times.sourceCheckedAt);
	const next = publication.times.expectedNextCheckAt
		? Date.parse(publication.times.expectedNextCheckAt)
		: source + 30_000;
	const cadence = Math.max(1_000, next - source);
	const staleAt = next + Math.max(5_000, Math.min(30_000, cadence * 0.25));
	const degradedAt = next + Math.max(30_000, cadence);
	return {
		staleAt: new Date(staleAt).toISOString(),
		state: now <= staleAt ? "FRESH" : now <= degradedAt ? "STALE" : "DEGRADED",
	};
};

export const leagueLiveTimesV2 = (
	publication: LeagueLiveManifestV2,
	now = new Date().toISOString()
) => ({
	sourceCheckedAt: publication.times.sourceCheckedAt,
	contentUpdatedAt: publication.times.contentUpdatedAt,
	publishedAt: publication.times.publishedAt,
	checkpointedAt: publication.times.checkpointedAt,
	servedAt: now,
	staleAt: freshness(publication, Date.parse(now)).staleAt,
	nextRefreshAt: publication.times.expectedNextCheckAt,
});

type LiveDeliveryCadenceTimesV2 = Pick<
	ReturnType<typeof leagueLiveTimesV2>,
	"sourceCheckedAt" | "nextRefreshAt"
>;

export const liveDeliveryFreshnessWindowV2 = (
	times: LiveDeliveryCadenceTimesV2,
	now = Date.now()
) => {
	const source = Date.parse(times.sourceCheckedAt);
	const next = times.nextRefreshAt ? Date.parse(times.nextRefreshAt) : Number.NaN;
	const cadence =
		Number.isFinite(source) && Number.isFinite(next) && next >= source
			? Math.max(1_000, next - source)
			: 30_000;
	const refreshAt = Number.isFinite(next) ? next : Number.isFinite(source) ? source + cadence : now;
	const staleAt = refreshAt + Math.max(5_000, Math.min(30_000, cadence * 0.25));
	const degradedAt = refreshAt + Math.max(30_000, cadence);
	return {
		staleAt: new Date(staleAt).toISOString(),
		degradedAt: new Date(degradedAt).toISOString(),
		state:
			now <= staleAt
				? ("FRESH" as const)
				: now <= degradedAt
					? ("STALE" as const)
					: ("DEGRADED" as const),
	};
};

export const liveDeliveryFreshnessStateV2 = (
	times: LiveDeliveryCadenceTimesV2,
	now = Date.now()
): "FRESH" | "STALE" | "DEGRADED" => {
	return liveDeliveryFreshnessWindowV2(times, now).state;
};

export const leagueLiveDeliveryV2 = (
	read: Pick<LeagueLivePublicationReadV2, "publication" | "servedFrom"> | LeagueLiveHeadReadV2,
	now = Date.now()
) => {
	const state =
		read.publication.state === "FINALIZED"
			? "FINAL"
			: read.servedFrom !== "REDIS_CURRENT"
				? "DEGRADED"
				: freshness(read.publication, now).state;
	const servedFrom = read.servedFrom;
	return {
		state,
		servedFrom,
		reasonCodes: [
			...(servedFrom !== "REDIS_CURRENT" ? ["FALLBACK_SERVED"] : []),
			...(state === "STALE" || state === "DEGRADED" ? ["SOURCE_CHECK_OVERDUE"] : []),
		],
	};
};

export const leagueLiveScopeKey = scopeKey;

export const LIVE_LEAGUE_CHECKPOINT_SQL = `
	SELECT manifest, index_payload, payload, row_count, payload_bytes, payload_sha256
	FROM competition.live_league_checkpoints
	WHERE season_id = $1 AND event_id = $2 AND tournament_id = $3 AND scope_kind = $4
	LIMIT 1
`;

/** Exact SQL/result-shape probe for the V2 league checkpoint fallback reader. */
export const LIVE_LEAGUE_DATA_SQL_CONTRACT: readonly DataSqlContractProbe[] = [
	...(["CLASSIC", "H2H_HEAD", "H2H_STANDINGS"] as const).map((scopeKind) => ({
		name: `live-league-v2.checkpoint-fallback.${scopeKind.toLowerCase()}`,
		sql: LIVE_LEAGUE_CHECKPOINT_SQL,
		values: [2026, 1, 1, scopeKind],
		resultTypes: [
			{
				relation: "competition.live_league_checkpoints",
				column: "manifest",
				pgType: "jsonb",
				acceptedPgTypes: ["json", "jsonb"],
			},
			{
				relation: "competition.live_league_checkpoints",
				column: "index_payload",
				pgType: "jsonb",
				acceptedPgTypes: ["json", "jsonb"],
			},
			{
				relation: "competition.live_league_checkpoints",
				column: "payload",
				pgType: "jsonb",
				acceptedPgTypes: ["json", "jsonb"],
			},
			{ relation: "competition.live_league_checkpoints", column: "row_count", pgType: "integer" },
			{
				relation: "competition.live_league_checkpoints",
				column: "payload_bytes",
				pgType: "integer",
			},
			{ relation: "competition.live_league_checkpoints", column: "payload_sha256", pgType: "text" },
		],
	})),
];
