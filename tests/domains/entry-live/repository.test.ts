import { describe, expect, it } from "bun:test";
import { entryLiveRepository } from "../../../src/domains/entry-live/repository";

const buildContext = (options: { cache?: string | null; rows?: unknown[] } = {}) => {
	const strings = new Map<string, string>();
	strings.set("Season:active", "2526");
	if (options.cache !== undefined && options.cache !== null) {
		strings.set("gql:v2:2526:entries:transfers:v2:1:3", options.cache);
	}

	const redis = {
		get: async (key: string) => strings.get(key) ?? null,
		set: async (key: string, value: string) => {
			strings.set(key, value);
			return "OK";
		},
		del: async (key: string) => (strings.delete(key) ? 1 : 0),
	};

	const result = { data: options.rows ?? [], error: null };
	const supabase = {
		from: () => {
			const query = Promise.resolve(result);
			type Builder = typeof query & {
				select: () => Builder;
				eq: () => Builder;
				in: () => Builder;
				order: () => Builder;
				limit: () => Builder;
			};
			const builder = query as Builder;
			Object.assign(builder, {
				select: () => builder,
				eq: () => builder,
				in: () => builder,
				order: () => builder,
				limit: () => builder,
			});
			return builder;
		},
	};

	return {
		redis,
		supabase,
		logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
	} as never;
};

describe("entryLiveRepository transfers", () => {
	it("returns every transfer in canonical transfer_time order", async () => {
		const context = buildContext({
			rows: [
				{
					entry_id: "1",
					event_id: "3",
					element_in_id: "20",
					element_out_id: "10",
					transfer_time: "2026-01-02T12:00:00Z",
				},
				{
					entry_id: 1,
					event_id: 3,
					element_in_id: 30,
					element_out_id: 20,
					transfer_time: "2026-01-01T12:00:00Z",
				},
			],
		});

		const transfers = await entryLiveRepository.getEntryEventTransfers(context, 1, 3);
		expect(transfers).toHaveLength(2);
		expect(transfers.map((row) => row.elementIn)).toEqual([30, 20]);
		expect(transfers.every((row) => row.eventId === 3 && row.entryId === 1)).toBe(true);
	});

	it("evicts malformed cache and retries the database", async () => {
		const context = buildContext({
			cache: "not-json",
			rows: [
				{ entry_id: 1, event_id: 3, element_in_id: 20, element_out_id: 10, transfer_time: null },
			],
		});

		const transfers = await entryLiveRepository.getEntryEventTransfers(context, 1, 3);
		expect(transfers).toHaveLength(1);
		expect(transfers[0]?.elementIn).toBe(20);
	});
});
