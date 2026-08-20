import { afterEach, describe, expect, it } from "bun:test";
import {
	lookupFplEntry,
	lookupFplEntryResult,
	mapFplEntrySummaryToEntry,
} from "../../src/infra/fpl-entry-lookup";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("mapFplEntrySummaryToEntry", () => {
	it("maps FPL summary fields onto the GraphQL Entry contract", () => {
		expect(
			mapFplEntrySummaryToEntry({
				id: 424242,
				name: "Let Let Me",
				player_first_name: "Tong",
				player_last_name: "Lam",
				player_region_name: "China",
				started_event: 1,
				summary_overall_points: 1234,
				summary_overall_rank: 56789,
				last_deadline_bank: 15,
				last_deadline_value: 1012,
				last_deadline_total_transfers: 3,
			})
		).toEqual({
			id: 424242,
			entryName: "Let Let Me",
			playerName: "Tong Lam",
			region: "China",
			startedEvent: 1,
			overallPoints: 1234,
			overallRank: 56789,
			bank: 15,
			teamValue: 1012,
			totalTransfers: 3,
			lastEventId: null,
			lastOverallPoints: null,
			lastOverallRank: null,
			lastTeamValue: null,
			lastBank: null,
		});
	});
});

describe("lookupFplEntry", () => {
	it("returns a mapped entry when FPL has the team", async () => {
		globalThis.fetch = (async (input: URL | string) => {
			expect(String(input)).toBe("https://fantasy.premierleague.com/api/entry/424242/");
			return new Response(
				JSON.stringify({
					id: 424242,
					name: "Let Let Me",
					player_first_name: "Tong",
					player_last_name: "Lam",
					summary_overall_points: 80,
					summary_overall_rank: 100,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } }
			);
		}) as unknown as typeof fetch;

		const entry = await lookupFplEntry(424242);
		expect(entry?.id).toBe(424242);
		expect(entry?.entryName).toBe("Let Let Me");
		expect(entry?.playerName).toBe("Tong Lam");
	});

	it("returns null for a missing or malformed FPL team", async () => {
		globalThis.fetch = (async () =>
			new Response("Not found", { status: 404 })) as unknown as typeof fetch;
		expect(await lookupFplEntry(1)).toBeNull();

		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ id: 2, name: "Wrong" }), {
				status: 200,
			})) as unknown as typeof fetch;
		expect(await lookupFplEntry(1)).toBeNull();
	});

	it("classifies 404 and transient responses separately", async () => {
		globalThis.fetch = (async () =>
			new Response("Not found", { status: 404 })) as unknown as typeof fetch;
		expect(await lookupFplEntryResult(1)).toEqual({ status: "not_found" });

		globalThis.fetch = (async () =>
			new Response("busy", { status: 503 })) as unknown as typeof fetch;
		expect(await lookupFplEntryResult(1)).toEqual({ status: "unavailable", reason: "transient" });

		globalThis.fetch = (async () =>
			new Response("bad", { status: 200 })) as unknown as typeof fetch;
		expect(await lookupFplEntryResult(1)).toEqual({
			status: "unavailable",
			reason: "invalid_response",
		});
	});
});
