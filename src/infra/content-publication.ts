import { createHash } from "node:crypto";

import type Redis from "ioredis";
import type { DataSqlContractProbe } from "../contracts/data-sql-contract";
import type { QueryExecutor } from "./database";
import { metrics } from "./metrics";

export const BRIEFING_WEEK_ACTIVE_POINTER_KEY = "llm:content:briefing:week:active";

const briefingReaderMetrics = { fallbacks: 0, corruptions: 0, repairs: 0, redisUnavailable: 0 };

const recordReaderEvent = (
	event: "fallback" | "corruption" | "repair" | "redis_unavailable"
): void => {
	if (event === "fallback") briefingReaderMetrics.fallbacks += 1;
	if (event === "corruption") briefingReaderMetrics.corruptions += 1;
	if (event === "repair") briefingReaderMetrics.repairs += 1;
	if (event === "redis_unavailable") briefingReaderMetrics.redisUnavailable += 1;
	metrics.briefingPublicationReaderEvents.labels(event).inc();
};

export function getBriefingReaderMetrics(): Readonly<typeof briefingReaderMetrics> {
	return { ...briefingReaderMetrics };
}

export type BriefingState =
	"READY" | "EMPTY" | "STALE" | "OFFSEASON" | "NOT_PUBLISHED" | "UNAVAILABLE" | "REMOVED";
export type BriefingLocale = "en" | "zh-CN";

export type BriefingStoryCard = {
	id: string;
	slug: string;
	storyRevision: number;
	title: string;
	summary: string;
	sourceName: string | null;
	sourceUrl: string | null;
	sourceCheckedAt: string | null;
	expiresAt: string | null;
};

export type BriefingSection = {
	key: string;
	title: string;
	items: BriefingStoryCard[];
};

export type BriefingEvent = {
	seasonCode: string;
	eventId: number;
	name: string;
	deadlineTime: string;
};

export type BriefingWeekPayload = {
	schemaVersion: 1;
	scopeKind: "SURFACE";
	scopeKey: "week";
	revision: number;
	publicationId: string;
	state: BriefingState;
	locale: BriefingLocale;
	publishedAt: string;
	sourceCheckedAt: string;
	validUntil: string | null;
	event: BriefingEvent | null;
	featured: BriefingStoryCard[];
	sections: BriefingSection[];
};

type ActiveMetadata = {
	publication_id: string;
	scope_key: string;
	revision: string | number;
	schema_version: number;
	season_code: string;
	target_event_id: number | null;
	event_name: string | null;
	deadline_time: string | Date | null;
	state: BriefingState;
	servable: boolean;
	source_checked_at: string | Date;
	published_at: string | Date;
	valid_until: string | Date | null;
	locale_manifest: Record<string, { bytes: number; sha256: string }>;
};

type ActivePointer = {
	schemaVersion: 1;
	publicationId: string;
	revision: number;
	state: BriefingState;
	locales: BriefingLocale[];
	hashes: Record<BriefingLocale, string>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

const iso = (value: unknown): string | null => {
	if (value instanceof Date) return value.toISOString();
	if (typeof value !== "string") return null;
	const time = Date.parse(value);
	return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

const canonicalize = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, canonicalize(value[key])])
	);
};

const serialized = (value: unknown): string => JSON.stringify(canonicalize(value));

const asStory = (value: unknown): BriefingStoryCard | null => {
	if (!isRecord(value)) return null;
	if (
		typeof value.id !== "string" ||
		typeof value.slug !== "string" ||
		typeof value.title !== "string" ||
		typeof value.summary !== "string"
	)
		return null;
	if (!Number.isSafeInteger(value.storyRevision) || Number(value.storyRevision) <= 0) return null;
	if (typeof value.sourceUrl === "string") {
		try {
			const protocol = new URL(value.sourceUrl).protocol;
			if (protocol !== "http:" && protocol !== "https:") return null;
		} catch {
			return null;
		}
	}
	return {
		id: value.id,
		slug: value.slug,
		storyRevision: Number(value.storyRevision),
		title: value.title,
		summary: value.summary,
		sourceName: typeof value.sourceName === "string" ? value.sourceName : null,
		sourceUrl: typeof value.sourceUrl === "string" ? value.sourceUrl : null,
		sourceCheckedAt: iso(value.sourceCheckedAt),
		expiresAt: iso(value.expiresAt),
	};
};

export function parseBriefingWeekPayload(
	value: unknown,
	locale: BriefingLocale
): BriefingWeekPayload | null {
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		value.scopeKind !== "SURFACE" ||
		value.scopeKey !== "week"
	)
		return null;
	if (
		value.locale !== locale ||
		typeof value.publicationId !== "string" ||
		!Number.isSafeInteger(value.revision)
	)
		return null;
	if (
		value.state !== "READY" &&
		value.state !== "EMPTY" &&
		value.state !== "STALE" &&
		value.state !== "OFFSEASON" &&
		value.state !== "NOT_PUBLISHED" &&
		value.state !== "UNAVAILABLE" &&
		value.state !== "REMOVED"
	)
		return null;
	const publishedAt = iso(value.publishedAt);
	const sourceCheckedAt = iso(value.sourceCheckedAt);
	if (!publishedAt || !sourceCheckedAt || (value.validUntil !== null && !iso(value.validUntil)))
		return null;
	const event =
		value.event === null
			? null
			: isRecord(value.event) &&
				  typeof value.event.seasonCode === "string" &&
				  Number.isSafeInteger(value.event.eventId) &&
				  typeof value.event.name === "string" &&
				  iso(value.event.deadlineTime)
				? {
						seasonCode: value.event.seasonCode,
						eventId: Number(value.event.eventId),
						name: value.event.name,
						deadlineTime: iso(value.event.deadlineTime) as string,
					}
				: null;
	if (value.event !== null && event === null) return null;
	if (!Array.isArray(value.featured) || !Array.isArray(value.sections)) return null;
	const featured = value.featured.map(asStory);
	if (featured.some((item) => item === null)) return null;
	const sections: BriefingSection[] = [];
	for (const section of value.sections) {
		if (
			!isRecord(section) ||
			typeof section.key !== "string" ||
			typeof section.title !== "string" ||
			!Array.isArray(section.items)
		)
			return null;
		const items = section.items.map(asStory);
		if (items.some((item) => item === null)) return null;
		sections.push({ key: section.key, title: section.title, items: items as BriefingStoryCard[] });
	}
	return {
		schemaVersion: 1,
		scopeKind: "SURFACE",
		scopeKey: "week",
		revision: Number(value.revision),
		publicationId: value.publicationId,
		state: value.state,
		locale,
		publishedAt,
		sourceCheckedAt,
		validUntil: value.validUntil === null ? null : iso(value.validUntil),
		event,
		featured: featured as BriefingStoryCard[],
		sections,
	};
}

const metadataDate = (value: string | Date | null): string | null => iso(value);

const hasLocalePair = (
	manifest: ActiveMetadata["locale_manifest"]
): manifest is Record<BriefingLocale, { bytes: number; sha256: string }> =>
	["en", "zh-CN"].every((locale) => {
		const entry: unknown = manifest[locale];
		return (
			isRecord(entry) &&
			typeof entry.bytes === "number" &&
			Number.isSafeInteger(entry.bytes) &&
			entry.bytes >= 0 &&
			typeof entry.sha256 === "string" &&
			/^[0-9a-f]{64}$/i.test(entry.sha256)
		);
	});

const toMetadata = (row: ActiveMetadata): ActiveMetadata => ({
	...row,
	revision: Number(row.revision),
	locale_manifest: row.locale_manifest ?? {},
});

export const BRIEFING_ACTIVE_METADATA_SQL = `
	SELECT publication_id, scope_key, revision, schema_version, season_code, target_event_id, event_name, deadline_time, state, servable, source_checked_at, published_at, valid_until, locale_manifest
	FROM content.briefing_active_publication
	WHERE scope_key = $1
	ORDER BY revision DESC
	LIMIT 1
`;

export const BRIEFING_EVENT_CONTEXT_SQL = `
	SELECT EXISTS (
		SELECT 1
		FROM fpl.events event
		JOIN fpl.seasons season ON season.season_id = event.season_id
		WHERE season.is_current AND (event.is_current OR event.is_next)
	) AS exists
`;

export const BRIEFING_PAYLOAD_FALLBACK_SQL = `
	SELECT payload, payload_bytes, payload_sha256
	FROM content.publication_payloads
	WHERE publication_id = $1 AND locale = $2
	LIMIT 1
`;

export const BRIEFING_DATA_SQL_CONTRACT: readonly DataSqlContractProbe[] = [
	{
		name: "briefing.active-metadata",
		sql: BRIEFING_ACTIVE_METADATA_SQL,
		values: ["week"],
	},
	{
		name: "briefing.event-context",
		sql: BRIEFING_EVENT_CONTEXT_SQL,
		values: [],
	},
	{
		name: "briefing.payload-fallback",
		sql: BRIEFING_PAYLOAD_FALLBACK_SQL,
		values: [null, "en"],
		resultTypes: [
			{
				relation: "content.publication_payloads",
				column: "payload",
				pgType: "jsonb",
			},
		],
	},
];

async function activeMetadata(database: QueryExecutor): Promise<ActiveMetadata | null> {
	const result = await database.query<ActiveMetadata>(BRIEFING_ACTIVE_METADATA_SQL, ["week"]);
	const row = result.rows[0];
	return row ? toMetadata(row) : null;
}

const payloadKey = (revision: number, locale: BriefingLocale): string =>
	`llm:content:briefing:week:${revision}:${locale}`;

const validateAgainstMetadata = (
	payload: BriefingWeekPayload,
	locale: BriefingLocale,
	metadata: ActiveMetadata,
	_raw: string
): boolean => {
	const manifest = metadata.locale_manifest[locale];
	if (
		!manifest ||
		payload.publicationId !== metadata.publication_id ||
		payload.revision !== Number(metadata.revision)
	)
		return false;
	const canonicalRaw = serialized(payload);
	return (
		Buffer.byteLength(canonicalRaw, "utf8") === Number(manifest.bytes) &&
		sha256(canonicalRaw) === manifest.sha256
	);
};

export type BriefingWeekRead = {
	state: BriefingState;
	payload: BriefingWeekPayload | null;
	publicationId: string | null;
	revision: number | null;
	sourceCheckedAt: string | null;
	publishedAt: string | null;
	staleAt: string | null;
	event: BriefingEvent | null;
};

const unavailable = (state: BriefingState = "UNAVAILABLE"): BriefingWeekRead => ({
	state,
	payload: null,
	publicationId: null,
	revision: null,
	sourceCheckedAt: null,
	publishedAt: null,
	staleAt: null,
	event: null,
});

async function hasCurrentOrNextEvent(database: QueryExecutor): Promise<boolean> {
	try {
		const result = await database.query<{ exists: boolean }>(BRIEFING_EVENT_CONTEXT_SQL);
		return result.rows[0]?.exists === true;
	} catch {
		// Content publication must fail closed as NOT_PUBLISHED when lifecycle
		// metadata cannot be read; only a confirmed empty event context is
		// allowed to produce OFFSEASON.
		return true;
	}
}

export async function readBriefingWeek(
	database: QueryExecutor,
	redis: Redis,
	locale: BriefingLocale
): Promise<BriefingWeekRead> {
	let metadata: ActiveMetadata | null;
	try {
		metadata = await activeMetadata(database);
	} catch {
		return unavailable();
	}
	if (!metadata)
		return (await hasCurrentOrNextEvent(database))
			? unavailable("NOT_PUBLISHED")
			: unavailable("OFFSEASON");
	if (!metadata.servable) {
		return {
			...unavailable(metadata.state),
			publicationId: metadata.publication_id,
			revision: Number(metadata.revision),
			sourceCheckedAt: metadataDate(metadata.source_checked_at),
			publishedAt: metadataDate(metadata.published_at),
			event:
				metadata.target_event_id && metadata.event_name && metadataDate(metadata.deadline_time)
					? {
							seasonCode: metadata.season_code,
							eventId: metadata.target_event_id,
							name: metadata.event_name,
							deadlineTime: metadataDate(metadata.deadline_time) as string,
						}
					: null,
		};
	}
	if (!hasLocalePair(metadata.locale_manifest)) {
		recordReaderEvent("corruption");
		return {
			...unavailable(),
			publicationId: metadata.publication_id,
			revision: Number(metadata.revision),
			sourceCheckedAt: metadataDate(metadata.source_checked_at),
			publishedAt: metadataDate(metadata.published_at),
		};
	}
	const revision = Number(metadata.revision);
	const deadlineTime = metadata.deadline_time ? metadataDate(metadata.deadline_time) : null;
	const event =
		metadata.target_event_id && metadata.event_name && deadlineTime
			? {
					seasonCode: metadata.season_code,
					eventId: metadata.target_event_id,
					name: metadata.event_name,
					deadlineTime,
				}
			: null;
	const validUntil = metadataDate(metadata.valid_until);
	const now = Date.now();
	if (validUntil && Date.parse(validUntil) <= now) {
		return {
			...unavailable("STALE"),
			publicationId: metadata.publication_id,
			revision,
			sourceCheckedAt: metadataDate(metadata.source_checked_at),
			publishedAt: metadataDate(metadata.published_at),
			staleAt: validUntil,
			event,
		};
	}

	let pointer: ActivePointer | null = null;
	let rawPayload: string | null = null;
	let redisUnavailable = false;
	let rawPointer: string | null = null;
	try {
		rawPointer = await redis.get(BRIEFING_WEEK_ACTIVE_POINTER_KEY);
	} catch {
		redisUnavailable = true;
		recordReaderEvent("redis_unavailable");
	}
	if (rawPointer !== null) {
		try {
			const parsed: unknown = JSON.parse(rawPointer);
			const isUsablePointer =
				isRecord(parsed) &&
				parsed.schemaVersion === 1 &&
				parsed.publicationId === metadata.publication_id &&
				Number(parsed.revision) === revision &&
				parsed.state === metadata.state &&
				Array.isArray(parsed.locales) &&
				parsed.locales.includes("en") &&
				parsed.locales.includes("zh-CN") &&
				isRecord(parsed.hashes) &&
				typeof parsed.hashes.en === "string" &&
				/^[0-9a-f]{64}$/i.test(parsed.hashes.en) &&
				typeof parsed.hashes["zh-CN"] === "string" &&
				/^[0-9a-f]{64}$/i.test(parsed.hashes["zh-CN"]);
			if (isUsablePointer) {
				pointer = parsed as unknown as ActivePointer;
				try {
					rawPayload = await redis.get(payloadKey(revision, locale));
				} catch {
					redisUnavailable = true;
					recordReaderEvent("redis_unavailable");
				}
			} else {
				recordReaderEvent("corruption");
			}
		} catch {
			recordReaderEvent("corruption");
		}
	}
	if (pointer && rawPayload === null && !redisUnavailable) {
		recordReaderEvent("corruption");
	}

	let payload: BriefingWeekPayload | null = null;
	if (pointer && rawPayload !== null) {
		try {
			const parsed = parseBriefingWeekPayload(JSON.parse(rawPayload), locale);
			const isValidPayload =
				parsed &&
				validateAgainstMetadata(parsed, locale, metadata, rawPayload) &&
				pointer.hashes.en === metadata.locale_manifest.en.sha256 &&
				pointer.hashes["zh-CN"] === metadata.locale_manifest["zh-CN"].sha256;
			if (isValidPayload) {
				payload = parsed;
			} else {
				recordReaderEvent("corruption");
			}
		} catch {
			recordReaderEvent("corruption");
			payload = null;
		}
	}

	if (!payload) {
		recordReaderEvent("fallback");
		try {
			const fallback = await database.query<{
				payload: unknown;
				payload_bytes: number;
				payload_sha256: string;
			}>(BRIEFING_PAYLOAD_FALLBACK_SQL, [metadata.publication_id, locale]);
			const row = fallback.rows[0];
			const parsed = row ? parseBriefingWeekPayload(row.payload, locale) : null;
			const manifest = metadata.locale_manifest[locale];
			if (
				parsed &&
				manifest &&
				Number(row.payload_bytes) === Buffer.byteLength(serialized(parsed), "utf8") &&
				row.payload_sha256 === manifest.sha256 &&
				validateAgainstMetadata(parsed, locale, metadata, serialized(parsed))
			)
				payload = parsed;
			if (payload && !redisUnavailable) recordReaderEvent("repair");
		} catch {
			return {
				...unavailable(),
				publicationId: metadata.publication_id,
				revision,
				sourceCheckedAt: metadataDate(metadata.source_checked_at),
				publishedAt: metadataDate(metadata.published_at),
				event,
			};
		}
	}

	if (!payload)
		return {
			...unavailable(),
			publicationId: metadata.publication_id,
			revision,
			sourceCheckedAt: metadataDate(metadata.source_checked_at),
			publishedAt: metadataDate(metadata.published_at),
			staleAt: validUntil,
			event,
		};
	return {
		state: payload.state,
		payload,
		publicationId: metadata.publication_id,
		revision,
		sourceCheckedAt: metadataDate(metadata.source_checked_at),
		publishedAt: metadataDate(metadata.published_at),
		staleAt: validUntil,
		event,
	};
}
