import { afterEach, describe, expect, it } from "bun:test";
import { requestManagerLiveScores } from "../../src/infra/manager-live-client";

const originalFetch = globalThis.fetch;
const originalUrl = process.env.LETLETME_DATA_URL;
const originalKey = process.env.LETLETME_DATA_API_KEY;

const row = {
	season: "2627",
	eventId: 1,
	entryId: 101,
	eventPoints: 38,
	netEventPoints: 34,
	totalPoints: 38,
	totalScope: "OVERALL",
	eventRank: 500,
	overallRank: 1000,
	leagueRank: 1,
	source: "FPL_ENTRY_SUMMARY",
	transferCost: 4,
	eventPointSemantics: "GROSS",
	revision: "row-revision",
	checkedAt: "2026-08-23T08:00:00.000Z",
	upstreamUpdatedAt: null,
	staleAt: "2026-08-23T08:01:30.000Z",
};

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalUrl === undefined) delete process.env.LETLETME_DATA_URL;
	else process.env.LETLETME_DATA_URL = originalUrl;
	if (originalKey === undefined) delete process.env.LETLETME_DATA_API_KEY;
	else process.env.LETLETME_DATA_API_KEY = originalKey;
	delete Bun.env.LETLETME_DATA_URL;
	delete Bun.env.LETLETME_DATA_API_KEY;
});

const configure = (): void => {
	process.env.LETLETME_DATA_URL = "http://data.example:3000/";
	process.env.LETLETME_DATA_API_KEY = "secret";
	Bun.env.LETLETME_DATA_URL = "http://data.example:3000/";
	Bun.env.LETLETME_DATA_API_KEY = "secret";
};

describe("requestManagerLiveScores", () => {
	it("always requests the bounded cache-only Data path and preserves last-good metadata", async () => {
		configure();
		globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
			expect(String(input)).toBe("http://data.example:3000/internal/manager-live/resolve");
			expect(init?.method).toBe("POST");
			expect(new Headers(init?.headers).get("x-api-key")).toBe("secret");
			expect(JSON.parse(String(init?.body))).toEqual({
				eventId: 1,
				entryIds: [101, 102],
				readMode: "CACHE_ONLY",
				tournamentId: 9,
			});
			return new Response(
				JSON.stringify({
					success: true,
					data: {
						season: "2627",
						eventId: 1,
						managerRevision: "manager-revision",
						dataAvailability: "LAST_GOOD",
						servedFrom: "MIXED",
						refreshQueued: true,
						rows: [row],
						missingEntryIds: [102],
						partial: true,
						errorCode: null,
						checkedAt: "2026-08-23T08:00:00.000Z",
						nextRefreshAt: "2026-08-23T08:00:30.000Z",
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } }
			);
		}) as unknown as typeof fetch;

		const result = await requestManagerLiveScores({
			eventId: 1,
			entryIds: [101, 102],
			tournamentId: 9,
			expectedSeason: "2627",
		});

		expect(result.season).toBe("2627");
		expect(result.rows.get(101)?.eventPoints).toBe(38);
		expect(result.managerRevision).toBe("manager-revision");
		expect(result.dataAvailability).toBe("LAST_GOOD");
		expect(result.servedFrom).toBe("MIXED");
		expect(result.refreshQueued).toBe(true);
		expect(result.missingEntryIds).toEqual([102]);
		expect(result.checkedAt).toBe("2026-08-23T08:00:00.000Z");
	});

	it("fails closed on malformed payloads without throwing into the board resolver", async () => {
		configure();
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					success: true,
					data: { season: "2627", eventId: 1, checkedAt: 42, rows: [row] },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } }
			)) as unknown as typeof fetch;

		const result = await requestManagerLiveScores({ eventId: 1, entryIds: [101] });

		expect(result.rows.size).toBe(0);
		expect(result.dataAvailability).toBe("UNAVAILABLE");
		expect(result.errorCode).toBe("UPSTREAM_UNAVAILABLE");
	});

	it("rejects display-formatted seasons instead of accepting a non-canonical Data contract", async () => {
		configure();
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					success: true,
					data: {
						season: "2026/27",
						eventId: 1,
						managerRevision: "manager-revision",
						dataAvailability: "FRESH",
						servedFrom: "REDIS",
						refreshQueued: false,
						rows: [{ ...row, season: "2026/27" }],
						missingEntryIds: [],
						partial: false,
						errorCode: null,
						checkedAt: "2026-08-23T08:00:00.000Z",
						nextRefreshAt: "2026-08-23T08:00:30.000Z",
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } }
			)) as unknown as typeof fetch;

		const result = await requestManagerLiveScores({
			eventId: 1,
			entryIds: [101],
			expectedSeason: "2627",
		});

		expect(result.rows.size).toBe(0);
		expect(result.dataAvailability).toBe("UNAVAILABLE");
	});

	it("rejects partial coverage that does not exactly match the requested entries", async () => {
		configure();
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					success: true,
					data: {
						season: "2627",
						eventId: 1,
						managerRevision: "manager-revision",
						dataAvailability: "PARTIAL",
						servedFrom: "REDIS",
						refreshQueued: true,
						rows: [row],
						missingEntryIds: [],
						partial: false,
						errorCode: null,
						checkedAt: "2026-08-23T08:00:00.000Z",
						nextRefreshAt: "2026-08-23T08:00:30.000Z",
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } }
			)) as unknown as typeof fetch;

		const result = await requestManagerLiveScores({ eventId: 1, entryIds: [101, 102] });

		expect(result.rows.size).toBe(0);
		expect(result.dataAvailability).toBe("UNAVAILABLE");
	});

	it("maps Data rate limiting to a stable manager availability result", async () => {
		configure();
		globalThis.fetch = (async () =>
			new Response("cooldown", { status: 429 })) as unknown as typeof fetch;

		const result = await requestManagerLiveScores({ eventId: 1, entryIds: [101] });

		expect(result.errorCode).toBe("UPSTREAM_RATE_LIMITED");
		expect(result.dataAvailability).toBe("UNAVAILABLE");
	});
});
