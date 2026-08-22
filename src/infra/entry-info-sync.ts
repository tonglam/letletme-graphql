const ENTRY_SYNC_TIMEOUT_MS = 8_000;

export type EntrySyncResult =
	{ ok: true; status: "queued"; jobId: string } | { ok: false; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const readEnv = (key: "LETLETME_DATA_URL" | "LETLETME_DATA_API_KEY"): string => {
	const value = Bun.env[key] ?? process.env[key];
	return typeof value === "string" ? value.trim() : "";
};

const getEntrySyncBaseUrl = (): string => readEnv("LETLETME_DATA_URL").replace(/\/+$/, "");

type QueuedEntrySyncBody = Record<string, unknown> | undefined;

async function requestQueuedEntrySync(
	path: string,
	body?: QueuedEntrySyncBody
): Promise<EntrySyncResult> {
	const baseUrl = getEntrySyncBaseUrl();
	if (!baseUrl) {
		return { ok: false, reason: "LETLETME_DATA_URL is not configured" };
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), ENTRY_SYNC_TIMEOUT_MS);
	const headers = new Headers({ Accept: "application/json", "Content-Type": "application/json" });
	const apiKey = readEnv("LETLETME_DATA_API_KEY");
	if (apiKey) {
		headers.set("x-api-key", apiKey);
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

	return requestQueuedEntrySync(`/entry-info/${entryId}/sync`);
}

export function enqueueEntryInfoSync(entryId: number): void {
	void requestEntryInfoSync(entryId);
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

	return requestQueuedEntrySync("/entry-sync/picks", {
		entryIds: [entryId],
		eventId,
	});
}

const entryPicksSyncFlights = new Map<string, Promise<EntrySyncResult>>();

export function enqueueEntryPicksSync(entryId: number, eventId: number): void {
	if (!Number.isSafeInteger(entryId) || entryId <= 0) return;
	if (!Number.isSafeInteger(eventId) || eventId <= 0) return;

	const key = `${entryId}:${eventId}`;
	if (entryPicksSyncFlights.has(key)) return;

	const flight = requestEntryPicksSync(entryId, eventId);
	entryPicksSyncFlights.set(key, flight);
	void flight.finally(() => {
		if (entryPicksSyncFlights.get(key) === flight) entryPicksSyncFlights.delete(key);
	});
}
