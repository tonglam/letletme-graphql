import { afterEach, describe, expect, it } from "bun:test";
import { requestPriceChangePredictions } from "../../src/infra/price-change-predictions-client";

const originalFetch = globalThis.fetch;
const originalUrl = process.env.LETLETME_DATA_URL;
const originalKey = process.env.LETLETME_DATA_API_KEY;

const validPlayer = {
	playerId: 1,
	playerCode: 101,
	webName: "Example",
	teamId: 1,
	teamName: "Example FC",
	teamShortName: "EXA",
	position: "MID",
	currentPrice: 100,
	selectedByPercent: 12.5,
	progressPercent: 75,
	hourlyRate: 0.5,
	status: "LIKELY_RISE",
	ownershipTrend: "UP",
	transfersInEvent: 1000,
	transfersOutEvent: 100,
	lockedUntil: null,
	calibrating: false,
	projections: [{ offset: 1, projectedPercent: 0.5, likelihood: 0.8 }],
};

const validBoard = {
	status: "READY",
	source: "FPL_BOOTSTRAP",
	deadline: "2026-08-22T10:00:00Z",
	nextDeadlines: ["2026-08-23T10:00:00Z"],
	fetchedAt: "2026-08-22T09:55:00Z",
	staleAt: "2026-08-22T10:55:00Z",
	revision: "revision-1",
	expectedPlayerCount: 1,
	observedPlayerCount: 1,
	players: [validPlayer],
};

function mockBoardResponse(board: unknown): void {
	process.env.LETLETME_DATA_URL = "http://data.example:3000/";
	process.env.LETLETME_DATA_API_KEY = "k1";
	Bun.env.LETLETME_DATA_URL = "http://data.example:3000/";
	Bun.env.LETLETME_DATA_API_KEY = "k1";
	globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
		expect(String(input)).toBe(
			"http://data.example:3000/internal/price-change-predictions/resolve"
		);
		expect(init?.method).toBe("POST");
		expect(new Headers(init?.headers).get("x-api-key")).toBe("k1");
		return new Response(JSON.stringify({ success: true, data: board }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as unknown as typeof fetch;
}

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalUrl === undefined) delete process.env.LETLETME_DATA_URL;
	else process.env.LETLETME_DATA_URL = originalUrl;
	if (originalKey === undefined) delete process.env.LETLETME_DATA_API_KEY;
	else process.env.LETLETME_DATA_API_KEY = originalKey;
	delete Bun.env.LETLETME_DATA_URL;
	delete Bun.env.LETLETME_DATA_API_KEY;
});

describe("requestPriceChangePredictions", () => {
	it("accepts a valid official board", async () => {
		mockBoardResponse(validBoard);

		const board = await requestPriceChangePredictions();

		expect(board.status).toBe("READY");
		expect(board.players).toHaveLength(1);
	});

	it("fails closed when any upstream player is malformed", async () => {
		mockBoardResponse({
			...validBoard,
			players: [validPlayer, { ...validPlayer, webName: 42 }],
			observedPlayerCount: 2,
		});

		expect((await requestPriceChangePredictions()).status).toBe("UNAVAILABLE");
	});

	it("fails closed when a deadline is not a GraphQL DateTime", async () => {
		mockBoardResponse({ ...validBoard, nextDeadlines: ["not-a-date"] });

		expect((await requestPriceChangePredictions()).status).toBe("UNAVAILABLE");
	});
});
