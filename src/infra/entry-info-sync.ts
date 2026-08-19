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

/**
 * Ask letletme_data to persist an FPL entry. GraphQL never writes PostgreSQL;
 * this is the same enqueue contract the website uses after bind.
 */
export async function requestEntryInfoSync(entryId: number): Promise<EntrySyncResult> {
	if (!Number.isSafeInteger(entryId) || entryId <= 0) {
		return { ok: false, reason: "invalid entry id" };
	}

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
		const response = await fetch(`${baseUrl}/entry-info/${entryId}/sync`, {
			method: "POST",
			headers,
			signal: controller.signal,
		});
		if (response.status === 202) {
			const body: unknown = await response.json().catch(() => null);
			if (
				isRecord(body) &&
				body.status === "queued" &&
				typeof body.jobId === "string" &&
				body.jobId
			) {
				return { ok: true, status: "queued", jobId: body.jobId };
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

export function enqueueEntryInfoSync(entryId: number): void {
	void requestEntryInfoSync(entryId);
}
