import { describe, expect, it } from "bun:test";

import { enrichTransferRows } from "../../../src/domains/entry-live/transfer-enrichment";
import type { Player } from "../../../src/infra/types";

const player = (id: number, price: number): Player => ({
	id,
	code: 1000 + id,
	webName: `Player ${id}`,
	firstName: null,
	secondName: null,
	teamId: id,
	position: 3,
	price,
	startPrice: price,
	totalPoints: 0,
	selectedByPercent: null,
});

describe("enrichTransferRows", () => {
	it("uses official stored transfer costs instead of mutable current prices", () => {
		const result = enrichTransferRows({
			entryId: 10,
			eventId: 3,
			transferRows: [
				{
					entryId: 10,
					eventId: 3,
					elementIn: 1,
					elementInCost: 55,
					elementOut: 2,
					elementOutCost: 60,
					time: "2026-08-01T00:00:00Z",
				},
			],
			playersById: new Map([
				[1, player(1, 99)],
				[2, player(2, 35)],
			]),
			teamsById: new Map(),
			liveByPlayer: new Map(),
		});

		expect(result[0].elementInCost).toBe(5.5);
		expect(result[0].elementOutCost).toBe(6);
	});
});
