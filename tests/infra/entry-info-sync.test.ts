import { afterEach, describe, expect, it, mock } from "bun:test";
import {
	enqueueEntryPicksSync,
	requestEntryInfoSync,
	requestEntryPicksSync,
} from "../../src/infra/entry-info-sync";

const originalFetch = globalThis.fetch;
const originalUrl = process.env.LETLETME_DATA_URL;
const originalKey = process.env.LETLETME_DATA_API_KEY;

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalUrl === undefined) delete process.env.LETLETME_DATA_URL;
	else process.env.LETLETME_DATA_URL = originalUrl;
	if (originalKey === undefined) delete process.env.LETLETME_DATA_API_KEY;
	else process.env.LETLETME_DATA_API_KEY = originalKey;
	delete Bun.env.LETLETME_DATA_URL;
	delete Bun.env.LETLETME_DATA_API_KEY;
});

describe("requestEntryInfoSync", () => {
	it("skips when Data URL is unset", async () => {
		delete process.env.LETLETME_DATA_URL;
		delete Bun.env.LETLETME_DATA_URL;
		expect(await requestEntryInfoSync(424242)).toEqual({
			ok: false,
			reason: "LETLETME_DATA_URL is not configured",
		});
	});

	it("posts the bind enqueue contract", async () => {
		process.env.LETLETME_DATA_URL = "http://data.example:3000/";
		process.env.LETLETME_DATA_API_KEY = "k1";
		Bun.env.LETLETME_DATA_URL = "http://data.example:3000/";
		Bun.env.LETLETME_DATA_API_KEY = "k1";
		globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
			expect(String(input)).toBe("http://data.example:3000/entry-info/424242/sync");
			expect(init?.method).toBe("POST");
			expect(new Headers(init?.headers).get("x-api-key")).toBe("k1");
			return new Response(JSON.stringify({ status: "queued", jobId: "job-9" }), { status: 202 });
		}) as unknown as typeof fetch;

		expect(await requestEntryInfoSync(424242)).toEqual({
			ok: true,
			status: "queued",
			jobId: "job-9",
		});
	});

	it("posts a missing live-picks enqueue contract", async () => {
		process.env.LETLETME_DATA_URL = "http://data.example:3000/";
		process.env.LETLETME_DATA_API_KEY = "k1";
		Bun.env.LETLETME_DATA_URL = "http://data.example:3000/";
		Bun.env.LETLETME_DATA_API_KEY = "k1";
		globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
			expect(String(input)).toBe("http://data.example:3000/entry-sync/picks");
			expect(init?.method).toBe("POST");
			expect(new Headers(init?.headers).get("x-api-key")).toBe("k1");
			expect(JSON.parse(String(init?.body))).toEqual({
				entryIds: [424242],
				eventId: 7,
			});
			return new Response(JSON.stringify({ success: true, jobId: "job-picks-9" }), {
				status: 202,
			});
		}) as unknown as typeof fetch;

		expect(await requestEntryPicksSync(424242, 7)).toEqual({
			ok: true,
			status: "queued",
			jobId: "job-picks-9",
		});
	});

	it("logs a background picks enqueue failure with its request ID", async () => {
		delete process.env.LETLETME_DATA_URL;
		delete Bun.env.LETLETME_DATA_URL;
		const warn = mock(() => undefined);

		enqueueEntryPicksSync(424242, 8, {
			logger: { warn } as never,
			requestId: "req-entry-picks",
		});
		await Bun.sleep(1);

		expect(warn).toHaveBeenCalledWith(
			{
				entryId: 424242,
				eventId: 8,
				reason: "LETLETME_DATA_URL is not configured",
				requestId: "req-entry-picks",
			},
			"Entry picks persistence enqueue failed"
		);
	});
});
