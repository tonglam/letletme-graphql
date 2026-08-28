import { isPlainRecord as isRecord } from "../contracts/guards";
import { getDataServiceConfig } from "./env";
import type { Logger } from "./logger";
import { metrics } from "./metrics";

const ENTRY_SYNC_TIMEOUT_MS = 2_000;

export type EntrySyncResult =
	{ ok: true; status: "queued"; jobId: string } | { ok: false; reason: string };

type QueuedEntrySyncBody = Record<string, unknown> | undefined;

async function requestQueuedEntrySync(
	path: string,
	body?: QueuedEntrySyncBody
): Promise<EntrySyncResult> {
	const config = getDataServiceConfig();
	const baseUrl = config.url.replace(/\/+$/, "");
	if (!baseUrl) {
		return { ok: false, reason: "LETLETME_DATA_URL is not configured" };
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), ENTRY_SYNC_TIMEOUT_MS);
	const headers = new Headers({ Accept: "application/json", "Content-Type": "application/json" });
	if (config.apiKey) {
		headers.set("x-api-key", config.apiKey);
	}

	try {
		const response = await fetch(`${baseUrl}${path}`, {
			method: "POST",
			headers,
			...(body ? { body: JSON.stringify(body) } : {}),
			signal: controller.signal,
		});
		if (response.status === 202) {
			const responseBody: unknown = await response.json().catch(() => null);
			if (
				isRecord(responseBody) &&
				typeof responseBody.jobId === "string" &&
				responseBody.jobId &&
				(responseBody.status === "queued" || responseBody.success === true)
			) {
				return { ok: true, status: "queued", jobId: responseBody.jobId };
			}
			return { ok: false, reason: "invalid queued response from entry sync service" };
		}
		return { ok: false, reason: `entry sync returned HTTP ${response.status}` };
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			return { ok: false, reason: `entry sync timed out after ${ENTRY_SYNC_TIMEOUT_MS}ms` };
		}
		return { ok: false, reason: "entry sync unavailable" };
	} finally {
		clearTimeout(timeoutId);
	}
}

/**
 * Ask letletme_data to persist an FPL entry. GraphQL never writes PostgreSQL;
 * this is the same enqueue contract the website uses after bind.
 */
export async function requestEntryInfoSync(entryId: number): Promise<EntrySyncResult> {
	if (!Number.isSafeInteger(entryId) || entryId <= 0) {
		return { ok: false, reason: "invalid entry id" };
	}

	const result = await requestQueuedEntrySync(`/entry-info/${entryId}/sync`);
	metrics.entrySyncRequestsTotal.labels("entry_info", result.ok ? "queued" : "failed").inc();
	return result;
}

/**
 * Queue the current-event lineup for public live-points lookups when the
 * read model has not seen this entry yet. This is deliberately asynchronous:
 * GraphQL does not write PostgreSQL in the request, and the next refresh
 * observes the persisted picks through the normal Data/Redis path.
 */
export async function requestEntryPicksSync(
	entryId: number,
	eventId: number
): Promise<EntrySyncResult> {
	if (!Number.isSafeInteger(entryId) || entryId <= 0) {
		return { ok: false, reason: "invalid entry id" };
	}
	if (!Number.isSafeInteger(eventId) || eventId <= 0) {
		return { ok: false, reason: "invalid event id" };
	}

	const result = await requestQueuedEntrySync("/entry-sync/picks", {
		entryIds: [entryId],
		eventId,
	});
	metrics.entrySyncRequestsTotal.labels("entry_picks", result.ok ? "queued" : "failed").inc();
	return result;
}

const entryPicksSyncFlights = new Map<string, Promise<EntrySyncResult>>();

type EntryPicksSyncObservability = Readonly<{
	logger?: Pick<Logger, "warn">;
	requestId?: string;
}>;

export function enqueueEntryPicksSync(
	entryId: number,
	eventId: number,
	observability: EntryPicksSyncObservability
): void {
	if (!Number.isSafeInteger(entryId) || entryId <= 0) return;
	if (!Number.isSafeInteger(eventId) || eventId <= 0) return;

	const key = `${entryId}:${eventId}`;
	if (entryPicksSyncFlights.has(key)) return;

	const flight = requestEntryPicksSync(entryId, eventId);
	entryPicksSyncFlights.set(key, flight);
	void flight
		.then((result) => {
			if (!result.ok) {
				observability.logger?.warn(
					{ entryId, eventId, reason: result.reason, requestId: observability.requestId },
					"Entry picks persistence enqueue failed"
				);
			}
		})
		.catch((error: unknown) => {
			// requestEntryPicksSync normally converts dependency failures into a
			// result. Retain a final rejection guard so the background flight can
			// never become an unhandled rejection or a silent persistence loss.
			observability.logger?.warn(
				{ err: error, entryId, eventId, requestId: observability.requestId },
				"Entry picks persistence enqueue crashed"
			);
		})
		.finally(() => {
			if (entryPicksSyncFlights.get(key) === flight) entryPicksSyncFlights.delete(key);
		});
}
