import { createHash } from "node:crypto";

import type { GraphQLContext } from "../../graphql/context";

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

const MAX_LKG_BYTES = 64 * 1024 * 1024;
const lkg = new Map<string, { value: LeagueLivePublicationReadV2; bytes: number }>();
let lkgBytes = 0;

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
	name: PublicationItem["name"]
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
		(revisions.officialRank !== null &&
			revisions.officialRank !== undefined &&
			!validHash(revisions.officialRank)) ||
		(revisions.schedule !== null &&
			revisions.schedule !== undefined &&
			!validHash(revisions.schedule)) ||
		(revisions.averageSide !== null &&
			revisions.averageSide !== undefined &&
			!validHash(revisions.averageSide)) ||
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
		!validItem(value.items.index, itemKey(scope, generation, "index"), "index") ||
		!validItem(value.items.payload, itemKey(scope, generation, "payload"), "payload")
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

const validIndexOnly = (
	value: unknown,
	publication: LeagueLiveManifestV2
): value is LeagueLiveIndexRowV2[] => {
	if (
		!Array.isArray(value) ||
		value.length !== publication.counts.expected ||
		value.length !== publication.items.index.count
	)
		return false;
	const entryIds = new Set<number>();
	for (const row of value) {
		if (!validIndexRow(row) || entryIds.has(row.entryId)) return false;
		entryIds.add(row.entryId);
	}
	const rows = value as unknown as LeagueLiveIndexRowV2[];
	return (
		publication.counts.published === rows.length &&
		publication.counts.ready === rows.filter((row) => row.availability === "READY").length &&
		publication.counts.noPicks === rows.filter((row) => row.availability === "NO_PICKS").length
	);
};

const validEntryInput = (
	value: unknown,
	row: LeagueLiveIndexRowV2,
	scope: LeagueLiveScope
): boolean => {
	if (!isRecord(value)) return false;
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

const validPublicationPayload = (
	index: unknown,
	payload: unknown,
	publication: LeagueLiveManifestV2,
	scope: LeagueLiveScope
): index is LeagueLiveIndexRowV2[] => {
	if (!Array.isArray(index) || !isRecord(payload)) return false;
	if (
		index.length !== publication.counts.expected ||
		index.length !== publication.items.index.count ||
		Object.keys(payload).length !== publication.items.payload.count ||
		Object.keys(payload).length !== index.length
	)
		return false;
	const ids = new Set<number>();
	for (const row of index) {
		if (!validIndexRow(row) || ids.has(row.entryId)) return false;
		ids.add(row.entryId);
		const value = payload[String(row.entryId)];
		if (row.availability === "READY") {
			if (
				row.inputPublicationId === null ||
				row.inputGeneration === null ||
				row.inputRevision === null ||
				row.inputContentUpdatedAt === null ||
				!validEntryInput(value, row, scope)
			)
				return false;
		} else if (value !== null) return false;
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

const remember = (scope: LeagueLiveScope, value: LeagueLivePublicationReadV2): void => {
	const bytes = Buffer.byteLength(canonicalJson(value), "utf8");
	const key = scopeKey(scope);
	const existing = lkg.get(key);
	if (existing) lkgBytes -= existing.bytes;
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

const readCheckpoint = async (
	context: GraphQLContext,
	scope: LeagueLiveScope,
	expectedGlobal?: { publicationId: string; generation: number }
): Promise<LeagueLivePublicationReadV2 | null> => {
	try {
		const result = await context.database.query<Record<string, unknown>>(
			`SELECT manifest, index_payload, payload, row_count, payload_bytes, payload_sha256
			 FROM competition.live_league_checkpoints
			 WHERE season_id = $1 AND event_id = $2 AND tournament_id = $3 AND scope_kind = 'CLASSIC'
			 LIMIT 1`,
			[context.currentSeason.seasonId, scope.eventId, scope.tournamentId]
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

export const readLeagueLivePublicationV2 = async (
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
	const cached = lkg.get(scopeKey(scope));
	if (
		cached &&
		(expectedGlobal === undefined ||
			(cached.value.publication.globalRef.publicationId === expectedGlobal.publicationId &&
				cached.value.publication.globalRef.generation === expectedGlobal.generation))
	)
		return { ...cached.value, servedFrom: "PROCESS_LKG" };
	return readCheckpoint(context, scope, expectedGlobal);
};

const readHeadPointer = async (
	context: GraphQLContext,
	scope: LeagueLiveScope,
	pointer: "active" | "previous"
): Promise<LeagueLiveHeadReadV2 | null> => {
	const raw = await context.redis.get(pointerKey(scope, pointer));
	const publication = parseManifest(raw, scope);
	return publication
		? { publication, servedFrom: pointer === "active" ? "REDIS_CURRENT" : "REDIS_PREVIOUS" }
		: null;
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
	for (const pointer of ["active", "previous"] as const) {
		try {
			const value = await readHeadPointer(context, scope, pointer);
			if (value) return value;
		} catch (error) {
			context.logger.warn(
				{ err: error, eventId: scope.eventId, tournamentId: scope.tournamentId, pointer },
				"Live league head read unavailable"
			);
		}
	}
	const cached = lkg.get(scopeKey(scope));
	if (cached) return { publication: cached.value.publication, servedFrom: "PROCESS_LKG" };
	const checkpoint = await readCheckpoint(context, scope);
	return checkpoint
		? { publication: checkpoint.publication, servedFrom: checkpoint.servedFrom }
		: null;
};

/**
 * Authorizes a live head probe from the immutable roster index.  The head
 * probe deliberately avoids the board payload; a full publication read is
 * only needed when Redis has already fallen back to process LKG/PostgreSQL.
 * `null` means that no complete publication was available and the caller may
 * use its narrow durable authorization fallback.
 */
export const readLeagueLivePublicationMembershipV2 = async (
	context: GraphQLContext,
	scope: LeagueLiveScope,
	entryId: number
): Promise<boolean | null> => {
	for (const pointer of ["active", "previous"] as const) {
		try {
			const head = await readHeadPointer(context, scope, pointer);
			if (!head) continue;
			const rawIndex = await context.redis.get(head.publication.items.index.key);
			const indexMeta = await context.redis.get(`${head.publication.items.index.key}:meta`);
			if (
				rawIndex === null ||
				indexMeta !==
					`${head.publication.items.index.count}|${head.publication.items.index.bytes}|${head.publication.items.index.sha256}` ||
				Buffer.byteLength(rawIndex, "utf8") !== head.publication.items.index.bytes
			)
				continue;
			const index = parseJson(rawIndex);
			if (
				hash(index) !== head.publication.items.index.sha256 ||
				!validIndexOnly(index, head.publication)
			)
				continue;
			return index.some((row) => row.entryId === entryId);
		} catch (error) {
			context.logger.warn(
				{ err: error, eventId: scope.eventId, tournamentId: scope.tournamentId, pointer },
				"Live league roster authorization probe unavailable"
			);
		}
	}
	try {
		const publication = await readLeagueLivePublicationV2(context, scope);
		return publication ? publication.index.some((row) => row.entryId === entryId) : null;
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
	staleAt: freshness(publication).staleAt,
	nextRefreshAt: publication.times.expectedNextCheckAt,
});

export const leagueLiveDeliveryV2 = (
	read: Pick<LeagueLivePublicationReadV2, "publication" | "servedFrom"> | LeagueLiveHeadReadV2,
	now = Date.now()
) => {
	const state =
		read.publication.state === "FINALIZED" ? "FINAL" : freshness(read.publication, now).state;
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
