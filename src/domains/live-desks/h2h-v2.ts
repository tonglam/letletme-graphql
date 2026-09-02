import { createHash } from "node:crypto";

import type { GraphQLContext } from "../../graphql/context";
import { LIVE_LEAGUE_CHECKPOINT_SQL } from "./league-v2";
import { isPublishedEntryLiveInputV2, type LivePublicationReadV2 } from "../entry-live/v2-service";

type H2HScope = "H2H_HEAD" | "H2H_STANDINGS";
type H2HMatchState = "READY" | "PENDING" | "ERROR";

export type H2HMatchSideV2 = {
	entryId: number | null;
	entryName: string;
	playerName: string | null;
	isAverage: boolean;
	officialNetPoints: number | null;
	inputPublicationId: string | null;
	inputGeneration: number | null;
	inputRevision: string | null;
	inputContentUpdatedAt: string | null;
	input: unknown | null;
};

export type H2HMatchPayloadV2 = {
	contractVersion: "live-points-v2";
	season: string;
	eventId: number;
	tournamentId: number;
	officialMatchId: number;
	groupId: number;
	sourceOrder: number;
	phase: "REGULAR" | "KNOCKOUT";
	knockoutName: string | null;
	tiebreak: string | null;
	isBye: boolean;
	state: H2HMatchState;
	sourceCheckedAt: string;
	globalRef: { publicationId: string; generation: number };
	home: H2HMatchSideV2;
	away: H2HMatchSideV2;
};

export type H2HStandingsRowV2 = {
	entryId: number;
	entryName: string;
	playerName: string | null;
	rank: number | null;
	matchPoints: number | null;
	played: number | null;
	won: number | null;
	drawn: number | null;
	lost: number | null;
	pointsFor: number | null;
};

export type H2HStandingsPayloadV2 = {
	contractVersion: "live-points-v2";
	season: string;
	eventId: number;
	tournamentId: number;
	throughEventId: number;
	state: "READY" | "UPDATING" | "UNAVAILABLE";
	sourceCheckedAt: string;
	rows: readonly H2HStandingsRowV2[];
};

export type H2HRevisionVectorV2 = {
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

export type H2HManifestV2 = {
	contractVersion: "live-points-v2";
	publicationId: string;
	generation: number;
	season: string;
	eventId: number;
	tournamentId: number;
	scope: H2HScope;
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
	revisions: H2HRevisionVectorV2;
	times: {
		sourceCheckedAt: string;
		contentUpdatedAt: string;
		publishedAt: string;
		checkpointedAt: string | null;
		expectedNextCheckAt: string | null;
	};
	counts: { expected: number; published: number; ready: number; noPicks: number };
	items: {
		index: PublicationItem;
		payload: PublicationItem;
	};
};

type PublicationItem = {
	name: "index" | "payload";
	key: string;
	type: "string";
	count: number;
	bytes: number;
	sha256: string;
};

type H2HIndexRow = {
	matchId: number;
	eventId: number;
	groupId: number;
	sourceOrder: number;
	phase: "REGULAR" | "KNOCKOUT";
	availability: H2HMatchState;
	homeEntryId: number | null;
	awayEntryId: number | null;
};

type H2HStandingsIndexRow = { entryId: number; availability: "READY" };

export type H2HLeaguePublicationReadV2 = {
	publication: H2HManifestV2;
	index: readonly (H2HIndexRow | H2HStandingsIndexRow)[];
	payload: Readonly<Record<string, unknown>>;
	servedFrom: "REDIS_CURRENT" | "REDIS_PREVIOUS" | "PROCESS_LKG" | "POSTGRES_CHECKPOINT";
};

export type H2HLeagueHeadReadV2 = {
	publication: H2HManifestV2;
	servedFrom: H2HLeaguePublicationReadV2["servedFrom"];
};

const MAX_H2H_ROWS = 5_000;
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_LKG_BYTES = 64 * 1024 * 1024;
const lkg = new Map<string, { value: H2HLeaguePublicationReadV2; bytes: number }>();
let lkgBytes = 0;
const requestPublicationMemo = new WeakMap<
	object,
	Map<string, Promise<H2HLeaguePublicationReadV2 | null>>
>();
type H2HLightReadV2 = {
	publication: H2HManifestV2;
	index: readonly (H2HIndexRow | H2HStandingsIndexRow)[];
	servedFrom: H2HLeaguePublicationReadV2["servedFrom"];
};
const requestLightMemo = new WeakMap<object, Map<string, Promise<H2HLightReadV2 | null>>>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const parseJson = (value: unknown): unknown => {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return null;
	}
};

const canonical = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (isRecord(value))
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
			.join(",")}}`;
	return JSON.stringify(value) ?? "null";
};

const hash = (value: unknown): string =>
	createHash("sha256").update(canonical(value), "utf8").digest("hex");

// Data stores revision vectors as hashes. Keep the producer's H2H algorithm
// identity here instead of comparing the manifest to the human-readable live
// points algorithm label used in GraphQL responses.
const H2H_LEAGUE_ALGORITHM_REVISION = hash("live-league-v2:h2h:1");

/**
 * H2H publications may be retained independently, but every final overlay
 * must still identify the exact global score contract it was built from.
 */
export const h2hPublicationMatchesGlobal = (
	publication: Pick<H2HManifestV2, "globalRef" | "revisions">,
	global: LivePublicationReadV2
): boolean =>
	publication.globalRef.publicationId === global.publication.publicationId &&
	publication.globalRef.generation === global.publication.generation &&
	publication.revisions.scoreCore === global.publication.revisions.scoreCore.revision &&
	publication.revisions.fixtureIdentity === global.publication.revisions.fixtureIdentity.revision &&
	publication.revisions.rules === global.publication.revisions.rules.revision &&
	publication.revisions.algorithm === H2H_LEAGUE_ALGORITHM_REVISION;

const iso = (value: unknown): value is string =>
	typeof value === "string" && Number.isFinite(Date.parse(value));

const positiveInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const validH2HGroupId = (value: unknown, phase: unknown): value is number =>
	typeof value === "number" &&
	Number.isSafeInteger(value) &&
	(phase === "KNOCKOUT" ? value >= 0 : value > 0);

const nullableInteger = (value: unknown, minimum?: number): boolean =>
	value === null ||
	(typeof value === "number" &&
		Number.isSafeInteger(value) &&
		(minimum === undefined || value >= minimum));

const validHash = (value: unknown): value is string =>
	typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

const validUuid = (value: unknown): value is string =>
	typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);

const scopeName = (scope: H2HScope): string =>
	scope === "H2H_HEAD" ? "h2h-head" : "h2h-standings";

const baseKey = (season: string, eventId: number, tournamentId: number, scope: H2HScope): string =>
	`llm:data:v2:fpl:league-live:${season}:${eventId}:${tournamentId}:${scopeName(scope)}`;

const itemKey = (
	season: string,
	eventId: number,
	tournamentId: number,
	scope: H2HScope,
	generation: number,
	name: PublicationItem["name"]
): string => `${baseKey(season, eventId, tournamentId, scope)}:${generation}:${name}`;

const pointerKey = (
	season: string,
	eventId: number,
	tournamentId: number,
	scope: H2HScope,
	pointer: "active" | "previous"
): string => `${baseKey(season, eventId, tournamentId, scope)}:${pointer}`;

const scopeKey = (season: string, eventId: number, tournamentId: number, scope: H2HScope): string =>
	`${season}:${eventId}:${tournamentId}:${scope}`;

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

const validRevisionVector = (value: unknown): value is H2HRevisionVectorV2 => {
	if (!isRecord(value)) return false;
	for (const key of [
		"roster",
		"scoreCore",
		"fixtureIdentity",
		"entryInputSet",
		"identity",
		"rules",
		"algorithm",
		"content",
	] as const) {
		if (!validHash(value[key])) return false;
	}
	for (const key of ["officialRank", "schedule", "averageSide"] as const) {
		if (
			!Object.prototype.hasOwnProperty.call(value, key) ||
			(value[key] !== null && !validHash(value[key]))
		)
			return false;
	}
	return true;
};

const validState = (value: unknown): value is H2HManifestV2["state"] =>
	[
		"PRE_DEADLINE",
		"PICKS_WAIT",
		"PICKS_PROBE",
		"PICKS_SYNC",
		"LIVE_ACTIVE",
		"BETWEEN_FIXTURES",
		"DAY_SETTLING",
		"GW_REVIEW",
		"FINALIZED",
	].includes(value as H2HManifestV2["state"]);

const parseManifest = (
	raw: unknown,
	season: string,
	eventId: number,
	tournamentId: number,
	scope: H2HScope
): H2HManifestV2 | null => {
	const value = parseJson(raw);
	if (!isRecord(value)) return null;
	const counts = value.counts;
	const items = value.items;
	const times = value.times;
	const globalRef = value.globalRef;
	if (!isRecord(counts) || !isRecord(items) || !isRecord(times) || !isRecord(globalRef))
		return null;
	const countsValid = ["expected", "published", "ready", "noPicks"].every(
		(key) =>
			typeof counts[key] === "number" &&
			Number.isSafeInteger(counts[key]) &&
			(counts[key] as number) >= 0
	);
	const expected = counts.expected as number;
	const published = counts.published as number;
	const ready = counts.ready as number;
	const noPicks = counts.noPicks as number;
	if (
		value.contractVersion !== "live-points-v2" ||
		!validUuid(value.publicationId) ||
		typeof value.generation !== "number" ||
		!Number.isSafeInteger(value.generation) ||
		value.generation <= 0 ||
		value.season !== season ||
		value.eventId !== eventId ||
		value.tournamentId !== tournamentId ||
		value.scope !== scope ||
		!validState(value.state) ||
		!validUuid(globalRef.publicationId) ||
		typeof globalRef.generation !== "number" ||
		!Number.isSafeInteger(globalRef.generation) ||
		globalRef.generation <= 0 ||
		!validRevisionVector(value.revisions) ||
		!iso(times.sourceCheckedAt) ||
		!iso(times.contentUpdatedAt) ||
		!iso(times.publishedAt) ||
		(times.checkpointedAt !== null && !iso(times.checkpointedAt)) ||
		(times.expectedNextCheckAt !== null && !iso(times.expectedNextCheckAt)) ||
		!countsValid ||
		expected > MAX_H2H_ROWS ||
		published !== expected ||
		ready > expected ||
		noPicks !== 0 ||
		!validItem(
			items.index,
			itemKey(season, eventId, tournamentId, scope, value.generation as number, "index"),
			"index",
			MAX_INDEX_BYTES
		) ||
		!validItem(
			items.payload,
			itemKey(season, eventId, tournamentId, scope, value.generation as number, "payload"),
			"payload",
			MAX_PAYLOAD_BYTES
		)
	)
		return null;
	return value as unknown as H2HManifestV2;
};

const validSide = (
	value: unknown,
	season: string,
	eventId: number,
	manifest: H2HManifestV2,
	isBye: boolean
): value is H2HMatchSideV2 => {
	if (!isRecord(value)) return false;
	const entryId = value.entryId;
	if (
		(entryId !== null && !positiveInteger(entryId)) ||
		typeof value.entryName !== "string" ||
		value.entryName.length === 0 ||
		(value.playerName !== null && typeof value.playerName !== "string") ||
		typeof value.isAverage !== "boolean" ||
		!nullableInteger(value.officialNetPoints) ||
		(value.inputPublicationId !== null && !validUuid(value.inputPublicationId)) ||
		(value.inputGeneration !== null && !positiveInteger(value.inputGeneration)) ||
		(value.inputRevision !== null && !validHash(value.inputRevision)) ||
		(value.inputContentUpdatedAt !== null && !iso(value.inputContentUpdatedAt))
	)
		return false;
	if (entryId === null) {
		return (
			(value.isAverage === true ||
				(isBye && value.isAverage === false && value.entryName === "Bye")) &&
			value.inputPublicationId === null &&
			value.inputGeneration === null &&
			value.inputRevision === null &&
			value.inputContentUpdatedAt === null &&
			value.input === null
		);
	}
	if (value.input === null) {
		return (
			value.isAverage === false &&
			value.inputPublicationId === null &&
			value.inputGeneration === null &&
			value.inputRevision === null &&
			value.inputContentUpdatedAt === null
		);
	}
	return (
		value.isAverage === false &&
		value.inputPublicationId !== null &&
		value.inputGeneration !== null &&
		value.inputRevision !== null &&
		value.inputContentUpdatedAt !== null &&
		isPublishedEntryLiveInputV2(value.input, season, eventId, entryId) &&
		hash(value.input) === value.inputRevision &&
		manifest.globalRef.generation > 0
	);
};

const validMatch = (value: unknown, manifest: H2HManifestV2): value is H2HMatchPayloadV2 => {
	if (!isRecord(value)) return false;
	if (typeof value.isBye !== "boolean") return false;
	const isBye = value.isBye;
	const validHome = validSide(value.home, manifest.season, manifest.eventId, manifest, value.isBye);
	const validAway = validSide(value.away, manifest.season, manifest.eventId, manifest, value.isBye);
	if (!validHome || !validAway) return false;
	const home = value.home as H2HMatchSideV2;
	const away = value.away as H2HMatchSideV2;
	const realSide = (side: H2HMatchSideV2): boolean => side.entryId !== null && !side.isAverage;
	const byePlaceholder = (side: H2HMatchSideV2): boolean =>
		side.entryId === null && !side.isAverage && side.entryName === "Bye";
	const completeSide = (side: H2HMatchSideV2): boolean =>
		side.entryId !== null
			? side.input !== null
			: side.isAverage
				? side.officialNetPoints !== null
				: true;
	const finalOfficialScoreAvailable = (side: H2HMatchSideV2): boolean =>
		value.isBye || (side.entryId === null && !side.isAverage)
			? true
			: side.officialNetPoints !== null;
	const lifecycleInputsValid = [home, away].every((side) => {
		if (side.entryId === null) return true;
		if (side.input === null || !isRecord(side.input))
			return manifest.state !== "FINALIZED" && value.state !== "READY";
		const input = side.input;
		return manifest.state === "FINALIZED" ? input.finalResult !== null : input.finalResult === null;
	});
	if (manifest.state === "FINALIZED" && value.state !== "READY") return false;
	return (
		value.contractVersion === "live-points-v2" &&
		value.season === manifest.season &&
		value.eventId === manifest.eventId &&
		value.tournamentId === manifest.tournamentId &&
		positiveInteger(value.officialMatchId) &&
		validH2HGroupId(value.groupId, value.phase) &&
		typeof value.sourceOrder === "number" &&
		Number.isSafeInteger(value.sourceOrder) &&
		value.sourceOrder >= 0 &&
		(value.phase === "REGULAR" || value.phase === "KNOCKOUT") &&
		(value.knockoutName === null || typeof value.knockoutName === "string") &&
		(value.tiebreak === null || typeof value.tiebreak === "string") &&
		typeof value.isBye === "boolean" &&
		(value.state === "READY" || value.state === "PENDING" || value.state === "ERROR") &&
		iso(value.sourceCheckedAt) &&
		isRecord(value.globalRef) &&
		validUuid(value.globalRef.publicationId) &&
		positiveInteger(value.globalRef.generation) &&
		(isBye
			? (realSide(home) && byePlaceholder(away)) || (realSide(away) && byePlaceholder(home))
			: !(
					(home.entryId !== null && home.entryId === away.entryId) ||
					(home.isAverage === true && away.isAverage === true)
				)) &&
		(value.state !== "READY" || (completeSide(home) && completeSide(away))) &&
		(manifest.state !== "FINALIZED" ||
			(value.state === "READY" &&
				finalOfficialScoreAvailable(home) &&
				finalOfficialScoreAvailable(away))) &&
		lifecycleInputsValid
	);
};

const validH2HIndex = (value: unknown, manifest: H2HManifestV2): value is H2HIndexRow[] => {
	if (
		!Array.isArray(value) ||
		value.length !== manifest.counts.expected ||
		value.length !== manifest.items.index.count
	)
		return false;
	const ids = new Set<number>();
	const participantIds = new Set<number>();
	let ready = 0;
	for (const row of value) {
		if (
			!isRecord(row) ||
			!positiveInteger(row.matchId) ||
			!positiveInteger(row.eventId) ||
			row.eventId !== manifest.eventId ||
			!validH2HGroupId(row.groupId, row.phase) ||
			typeof row.sourceOrder !== "number" ||
			!Number.isSafeInteger(row.sourceOrder) ||
			row.sourceOrder < 0 ||
			(row.phase !== "REGULAR" && row.phase !== "KNOCKOUT") ||
			(row.homeEntryId !== null && !positiveInteger(row.homeEntryId)) ||
			(row.awayEntryId !== null && !positiveInteger(row.awayEntryId)) ||
			(row.availability !== "READY" &&
				row.availability !== "PENDING" &&
				row.availability !== "ERROR") ||
			ids.has(row.matchId)
		)
			return false;
		ids.add(row.matchId);
		for (const participantId of [row.homeEntryId, row.awayEntryId]) {
			if (participantId !== null) {
				if (participantIds.has(participantId)) return false;
				participantIds.add(participantId);
			}
		}
		if (row.availability === "READY") ready++;
	}
	return manifest.counts.ready === ready;
};

const validH2HStandingsIndex = (
	value: unknown,
	manifest: H2HManifestV2
): value is H2HStandingsIndexRow[] => {
	if (
		!Array.isArray(value) ||
		value.length !== manifest.counts.expected ||
		value.length !== manifest.items.index.count ||
		manifest.counts.ready !== value.length
	)
		return false;
	const ids = new Set<number>();
	for (const row of value) {
		if (
			!isRecord(row) ||
			!positiveInteger(row.entryId) ||
			row.availability !== "READY" ||
			ids.has(row.entryId)
		)
			return false;
		ids.add(row.entryId);
	}
	return true;
};

const validHeadPayload = (
	index: unknown,
	payload: unknown,
	manifest: H2HManifestV2
): index is H2HIndexRow[] => {
	if (!isRecord(payload) || !validH2HIndex(index, manifest)) return false;
	const indexRows = index;
	if (
		Object.keys(payload).length !== manifest.items.payload.count ||
		Object.keys(payload).length !== indexRows.length
	)
		return false;
	const ids = new Set<number>();
	for (const row of indexRows) {
		ids.add(row.matchId);
		const match = payload[String(row.matchId)];
		if (
			!validMatch(match, manifest) ||
			match.officialMatchId !== row.matchId ||
			match.state !== row.availability ||
			match.home.entryId !== row.homeEntryId ||
			match.away.entryId !== row.awayEntryId ||
			match.eventId !== row.eventId ||
			match.groupId !== row.groupId ||
			match.sourceOrder !== row.sourceOrder ||
			match.phase !== row.phase
		)
			return false;
	}
	return (
		Object.keys(payload).every((key) => /^\d+$/.test(key) && ids.has(Number(key))) &&
		manifest.counts.ready === indexRows.filter((row) => row.availability === "READY").length
	);
};

const validStandingsPayload = (
	index: unknown,
	payload: unknown,
	manifest: H2HManifestV2
): index is H2HStandingsIndexRow[] => {
	if (!Array.isArray(index) || !isRecord(payload) || !isRecord(payload.standings)) return false;
	const standings = payload.standings;
	if (
		standings.contractVersion !== "live-points-v2" ||
		standings.season !== manifest.season ||
		standings.eventId !== manifest.eventId ||
		standings.tournamentId !== manifest.tournamentId ||
		typeof standings.throughEventId !== "number" ||
		!Number.isSafeInteger(standings.throughEventId) ||
		standings.throughEventId < 0 ||
		standings.throughEventId > manifest.eventId ||
		(standings.state === "READY" && standings.throughEventId !== manifest.eventId) ||
		(standings.state !== "READY" &&
			standings.state !== "UPDATING" &&
			standings.state !== "UNAVAILABLE") ||
		!iso(standings.sourceCheckedAt) ||
		!Array.isArray(standings.rows) ||
		manifest.items.payload.count !== 1 ||
		Object.keys(payload).length !== 1 ||
		!validH2HStandingsIndex(index, manifest)
	)
		return false;
	const standingRows: unknown[] = standings.rows;
	const ids = new Set(index.map((row) => row.entryId));
	if (
		(standings.state === "READY" && standingRows.length !== index.length) ||
		(standings.state === "UPDATING" &&
			standingRows.length !== 0 &&
			standingRows.length !== index.length) ||
		(standings.state === "UNAVAILABLE" && standingRows.length !== 0)
	)
		return false;
	const standingIds = new Set<number>();
	for (const row of standingRows) {
		if (
			!isRecord(row) ||
			!positiveInteger(row.entryId) ||
			standingIds.has(row.entryId) ||
			typeof row.entryName !== "string" ||
			row.entryName.length === 0 ||
			(row.playerName !== null && typeof row.playerName !== "string") ||
			!nullableInteger(row.rank, 1) ||
			!nullableInteger(row.matchPoints, 0) ||
			!nullableInteger(row.played, 0) ||
			!nullableInteger(row.won, 0) ||
			!nullableInteger(row.drawn, 0) ||
			!nullableInteger(row.lost, 0) ||
			!nullableInteger(row.pointsFor)
		)
			return false;
		standingIds.add(row.entryId);
	}
	const typedStandingRows = standingRows as H2HStandingsRowV2[];
	if (
		standings.state === "READY" &&
		typedStandingRows.some(
			(row) =>
				row.rank === null ||
				row.matchPoints === null ||
				row.played === null ||
				row.won === null ||
				row.drawn === null ||
				row.lost === null ||
				row.pointsFor === null ||
				row.played !== row.won + row.drawn + row.lost ||
				row.matchPoints !== row.won * 3 + row.drawn
		)
	)
		return false;
	if (standings.state === "READY" && typedStandingRows.length === 0) return false;
	return [...standingIds].every((entryId) => ids.has(entryId));
};

const validPayload = (
	index: unknown,
	payload: unknown,
	manifest: H2HManifestV2
): index is (H2HIndexRow | H2HStandingsIndexRow)[] =>
	manifest.scope === "H2H_HEAD"
		? validHeadPayload(index, payload, manifest)
		: validStandingsPayload(index, payload, manifest);

const remember = (scope: string, value: H2HLeaguePublicationReadV2): void => {
	const bytes = Buffer.byteLength(canonical(value), "utf8");
	const existing = lkg.get(scope);
	if (existing) lkgBytes -= existing.bytes;
	lkg.delete(scope);
	lkg.set(scope, { value, bytes });
	lkgBytes += bytes;
	while (lkgBytes > MAX_LKG_BYTES && lkg.size > 0) {
		const oldest = lkg.keys().next().value as string | undefined;
		if (oldest === undefined) break;
		const removed = lkg.get(oldest);
		lkg.delete(oldest);
		if (removed) lkgBytes -= removed.bytes;
	}
};

const readRemembered = (scope: string): H2HLeaguePublicationReadV2 | null => {
	const cached = lkg.get(scope);
	if (!cached) return null;
	// Map insertion order is the LRU order. Touch a hit before returning it so
	// frequently used tournament scopes are evicted last.
	lkg.delete(scope);
	lkg.set(scope, cached);
	return cached.value;
};

const readRedisPointer = async (
	context: GraphQLContext,
	season: string,
	eventId: number,
	tournamentId: number,
	scope: H2HScope,
	pointer: "active" | "previous"
): Promise<H2HLeaguePublicationReadV2 | null> => {
	const raw = await context.redis.get(pointerKey(season, eventId, tournamentId, scope, pointer));
	const publication = parseManifest(raw, season, eventId, tournamentId, scope);
	if (!publication) return null;
	const values = await context.redis.mget(
		publication.items.index.key,
		`${publication.items.index.key}:meta`,
		publication.items.payload.key,
		`${publication.items.payload.key}:meta`
	);
	const [indexRaw, indexMeta, payloadRaw, payloadMeta] = values;
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
	if (!validPayload(index, payload, publication)) return null;
	return {
		publication,
		index,
		payload: payload as Readonly<Record<string, unknown>>,
		servedFrom: pointer === "active" ? "REDIS_CURRENT" : "REDIS_PREVIOUS",
	};
};

/**
 * Head probes validate both immutable siblings before exposing a publication
 * revision. They do not project the embedded match sides.
 */
const readRedisLightPointer = async (
	context: GraphQLContext,
	season: string,
	eventId: number,
	tournamentId: number,
	scope: H2HScope,
	pointer: "active" | "previous"
): Promise<H2HLightReadV2 | null> => {
	const raw = await context.redis.get(pointerKey(season, eventId, tournamentId, scope, pointer));
	const publication = parseManifest(raw, season, eventId, tournamentId, scope);
	if (!publication) return null;
	const [indexRaw, indexMeta, payloadRaw, payloadMeta] = await context.redis.mget(
		publication.items.index.key,
		`${publication.items.index.key}:meta`,
		publication.items.payload.key,
		`${publication.items.payload.key}:meta`
	);
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
	const parsedIndex = parseJson(indexRaw);
	let index: H2HIndexRow[] | H2HStandingsIndexRow[];
	if (scope === "H2H_HEAD") {
		if (!validH2HIndex(parsedIndex, publication)) return null;
		index = parsedIndex;
	} else {
		if (!validH2HStandingsIndex(parsedIndex, publication)) return null;
		index = parsedIndex;
	}
	return {
		publication,
		index,
		servedFrom: pointer === "active" ? "REDIS_CURRENT" : "REDIS_PREVIOUS",
	};
};

const expectedGlobalMatches = (
	publication: H2HManifestV2,
	expectedGlobal?: { publicationId: string; generation: number }
): boolean =>
	expectedGlobal === undefined ||
	(publication.globalRef.publicationId === expectedGlobal.publicationId &&
		publication.globalRef.generation === expectedGlobal.generation);

const readCheckpoint = async (
	context: GraphQLContext,
	season: string,
	eventId: number,
	tournamentId: number,
	scope: H2HScope,
	expectedGlobal?: { publicationId: string; generation: number }
): Promise<H2HLeaguePublicationReadV2 | null> => {
	try {
		const result = await context.database.query<Record<string, unknown>>(
			LIVE_LEAGUE_CHECKPOINT_SQL,
			[context.currentSeason.seasonId, eventId, tournamentId, scope]
		);
		const row = result.rows[0];
		if (!row) return null;
		const publication = parseManifest(row.manifest, season, eventId, tournamentId, scope);
		if (!publication || !expectedGlobalMatches(publication, expectedGlobal)) return null;
		const index = parseJson(row.index_payload);
		const payload = parseJson(row.payload);
		if (!validPayload(index, payload, publication)) return null;
		const packed = { index, payload };
		if (
			publication.items.index.bytes !== Buffer.byteLength(canonical(index), "utf8") ||
			publication.items.index.sha256 !== hash(index) ||
			publication.items.payload.bytes !== Buffer.byteLength(canonical(payload), "utf8") ||
			publication.items.payload.sha256 !== hash(payload) ||
			row.payload_sha256 !== hash(packed) ||
			row.payload_bytes !== Buffer.byteLength(canonical(packed), "utf8") ||
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
			{ err: error, eventId, tournamentId, scope },
			"H2H league checkpoint read unavailable"
		);
		return null;
	}
};

const readH2HLeaguePublicationUnmemoized = async (
	context: GraphQLContext,
	tournamentId: number,
	eventId: number,
	scope: H2HScope,
	expectedGlobal?: { publicationId: string; generation: number }
): Promise<H2HLeaguePublicationReadV2 | null> => {
	const season = context.currentSeason.seasonCode;
	const key = scopeKey(season, eventId, tournamentId, scope);
	for (const pointer of ["active", "previous"] as const) {
		try {
			const value = await readRedisPointer(context, season, eventId, tournamentId, scope, pointer);
			if (value && expectedGlobalMatches(value.publication, expectedGlobal)) {
				remember(key, value);
				return value;
			}
		} catch (error) {
			context.logger.warn(
				{ err: error, eventId, tournamentId, scope, pointer },
				"H2H league Redis read unavailable"
			);
		}
	}
	const cached = readRemembered(key);
	if (cached && expectedGlobalMatches(cached.publication, expectedGlobal)) {
		return { ...cached, servedFrom: "PROCESS_LKG" };
	}
	return readCheckpoint(context, season, eventId, tournamentId, scope, expectedGlobal);
};

export const readH2HLeaguePublicationV2 = (
	context: GraphQLContext,
	tournamentId: number,
	eventId: number,
	scope: H2HScope,
	expectedGlobal?: { publicationId: string; generation: number }
): Promise<H2HLeaguePublicationReadV2 | null> => {
	let memo = requestPublicationMemo.get(context);
	if (!memo) {
		memo = new Map();
		requestPublicationMemo.set(context, memo);
	}
	const expectedKey = expectedGlobal
		? `:${expectedGlobal.publicationId}:${expectedGlobal.generation}`
		: "";
	const key = `${scopeKey(context.currentSeason.seasonCode, eventId, tournamentId, scope)}${expectedKey}`;
	const existing = memo.get(key);
	if (existing) return existing;
	const baseKey = scopeKey(context.currentSeason.seasonCode, eventId, tournamentId, scope);
	const base = expectedGlobal ? memo.get(baseKey) : undefined;
	const load = base
		? base.then((value) =>
				value && expectedGlobalMatches(value.publication, expectedGlobal)
					? value
					: readH2HLeaguePublicationUnmemoized(
							context,
							tournamentId,
							eventId,
							scope,
							expectedGlobal
						)
			)
		: readH2HLeaguePublicationUnmemoized(context, tournamentId, eventId, scope, expectedGlobal);
	memo.set(key, load);
	return load;
};

const readH2HLeagueLightV2 = async (
	context: GraphQLContext,
	tournamentId: number,
	eventId: number,
	scope: H2HScope
): Promise<H2HLightReadV2 | null> => {
	let memo = requestLightMemo.get(context);
	if (!memo) {
		memo = new Map();
		requestLightMemo.set(context, memo);
	}
	const key = scopeKey(context.currentSeason.seasonCode, eventId, tournamentId, scope);
	const existing = memo.get(key);
	if (existing) return existing;
	const load = (async (): Promise<H2HLightReadV2 | null> => {
		const season = context.currentSeason.seasonCode;
		for (const pointer of ["active", "previous"] as const) {
			try {
				const value = await readRedisLightPointer(
					context,
					season,
					eventId,
					tournamentId,
					scope,
					pointer
				);
				if (value) return value;
			} catch (error) {
				context.logger.warn(
					{ err: error, eventId, tournamentId, scope, pointer },
					"H2H league light Redis read unavailable"
				);
			}
		}
		const cached = readRemembered(key);
		if (cached) {
			return {
				publication: cached.publication,
				index: cached.index,
				servedFrom: "PROCESS_LKG",
			};
		}
		const complete = await readH2HLeaguePublicationV2(context, tournamentId, eventId, scope);
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
	tournamentId: number,
	eventId: number,
	scope: H2HScope
): Promise<H2HLeagueHeadReadV2 | null> => {
	const light = await readH2HLeagueLightV2(context, tournamentId, eventId, scope);
	return light ? { publication: light.publication, servedFrom: light.servedFrom } : null;
};

export const readH2HLeagueHeadV2 = async (
	context: GraphQLContext,
	tournamentId: number,
	eventId: number,
	scope: H2HScope = "H2H_HEAD"
): Promise<H2HLeagueHeadReadV2 | null> => {
	try {
		return await readHead(context, tournamentId, eventId, scope);
	} catch (error) {
		context.logger.warn(
			{ err: error, eventId, tournamentId, scope },
			"H2H league head read unavailable"
		);
		return null;
	}
};

/** Read H2H membership from the request-scoped complete publication. */
export const readH2HLeagueMembershipV2 = async (
	context: GraphQLContext,
	tournamentId: number,
	eventId: number,
	entryId: number
): Promise<boolean | null> => {
	try {
		const light = await readH2HLeagueLightV2(context, tournamentId, eventId, "H2H_HEAD");
		if (
			light &&
			light.index.some(
				(row) =>
					"homeEntryId" in row && (row.homeEntryId === entryId || row.awayEntryId === entryId)
			)
		)
			return true;
		// A complete H2H head can legitimately have no current matchup for a
		// roster member (for example a knockout bye). Use the independent
		// standings index as the complete-roster authorization source. If neither
		// publication is available, return null so the caller uses cold access.
		const standings = await readH2HLeagueLightV2(context, tournamentId, eventId, "H2H_STANDINGS");
		if (standings)
			return standings.index.some((row) => "entryId" in row && row.entryId === entryId);
		return light ? false : null;
	} catch (error) {
		context.logger.warn(
			{ err: error, eventId, tournamentId },
			"H2H roster authorization fallback unavailable"
		);
		return null;
	}
};

const freshness = (publication: H2HManifestV2, now = Date.now()) => {
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

export const h2hLeagueTimesV2 = (publication: H2HManifestV2, now = new Date().toISOString()) => ({
	sourceCheckedAt: publication.times.sourceCheckedAt,
	contentUpdatedAt: publication.times.contentUpdatedAt,
	publishedAt: publication.times.publishedAt,
	checkpointedAt: publication.times.checkpointedAt,
	servedAt: now,
	staleAt: freshness(publication, Date.parse(now)).staleAt,
	nextRefreshAt: publication.times.expectedNextCheckAt,
});

export const h2hLeagueDeliveryV2 = (
	read: Pick<H2HLeaguePublicationReadV2, "publication" | "servedFrom"> | H2HLeagueHeadReadV2,
	now = Date.now()
) => {
	const state =
		read.publication.state === "FINALIZED"
			? "FINAL"
			: read.servedFrom !== "REDIS_CURRENT"
				? "DEGRADED"
				: freshness(read.publication, now).state;
	return {
		state,
		servedFrom: read.servedFrom,
		reasonCodes: [
			...(read.servedFrom !== "REDIS_CURRENT" ? ["FALLBACK_SERVED"] : []),
			...(state === "STALE" || state === "DEGRADED" ? ["SOURCE_CHECK_OVERDUE"] : []),
		],
	};
};
