import { describe, expect, it } from "bun:test";
import type { EntryEventResult } from "../../../src/domains/entries/repository";
import { entriesService } from "../../../src/domains/entries/service";
import {
	type EntryEventTransferRow,
	entryLiveRepository,
} from "../../../src/domains/entry-live/repository";
import type { GraphQLContext } from "../../../src/graphql/context";

const makeMockRedis = (data: {
	season?: string;
	players?: Record<string, string>;
	teams?: Record<string, string>;
	eventLive?: Record<string, Record<string, string>>;
}) => {
	const strings = new Map<string, string>();
	if (data.season !== undefined) {
		strings.set("season:current", data.season);
	}
	return {
		get: async (key: string): Promise<string | null> =>
			strings.get(key) ?? null,
		set: async (
			_key: string,
			_value: string,
			..._args: unknown[]
		): Promise<string> => "OK",
		hget: async (key: string, field: string): Promise<string | null> => {
			if (key.startsWith("Player:") && data.players) {
				return data.players[field] ?? null;
			}
			if (key.startsWith("Team:") && data.teams) {
				return data.teams[field] ?? null;
			}
			return null;
		},
		hmget: async (
			key: string,
			...fields: string[]
		): Promise<(string | null)[]> => {
			if (key.startsWith("Player:") && data.players) {
				return fields.map((f) => data.players?.[f] ?? null);
			}
			return fields.map(() => null);
		},
		hgetall: async (key: string): Promise<Record<string, string>> => {
			if (key.startsWith("Player:") && data.players) {
				return data.players;
			}
			if (key.startsWith("Team:") && data.teams) {
				return data.teams;
			}
			if (data.eventLive) {
				for (const [liveKey, liveData] of Object.entries(data.eventLive)) {
					if (key === liveKey) {
						return liveData;
					}
				}
			}
			return {};
		},
		hset: async (..._args: unknown[]): Promise<number> => 1,
		expire: async (..._args: unknown[]): Promise<number> => 1,
		pipeline: () => {
			const queued: Array<[string, string[]]> = [];
			const p: {
				exec: () => Promise<Array<[null, (string | null)[]]>>;
			} & Record<string, unknown> = {
				hmget: (key: string, ...fields: string[]) => {
					queued.push([key, fields]);
					return p;
				},
				exec: async () =>
					queued.map(([key, fields]) => {
						const hash = data.eventLive?.[key] ?? {};
						return [null, fields.map((f) => hash[f] ?? null)];
					}),
			};
			return p;
		},
	};
};

const makeMockSupabase = () => ({
	from: (_table: string) => {
		const builder = {
			select: () => builder,
			eq: () => builder,
			in: () => builder,
			limit: async () => ({ data: [], error: null }),
			order: () => builder,
		};
		return builder;
	},
	rpc: async () => ({ data: null, error: null }),
});

const makeMockLogger = () => ({
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
});

const makeContext = (data: {
	season?: string;
	players?: Record<string, string>;
	teams?: Record<string, string>;
	eventLive?: Record<string, Record<string, string>>;
}): GraphQLContext =>
	({
		redis: makeMockRedis(data),
		supabase: makeMockSupabase(),
		logger: makeMockLogger(),
		user: undefined,
	}) as unknown as GraphQLContext;

const PLAYER_1 = JSON.stringify({
	webName: "Saka",
	type: 3,
	teamId: 1,
	code: 101,
	price: 75,
});
const PLAYER_2 = JSON.stringify({
	webName: "Salah",
	type: 3,
	teamId: 2,
	code: 102,
	price: 130,
});
const TEAM_1 = JSON.stringify({
	id: 1,
	code: 3,
	name: "Arsenal",
	shortName: "ARS",
});
const TEAM_2 = JSON.stringify({
	id: 2,
	code: 14,
	name: "Liverpool",
	shortName: "LIV",
});

describe("entriesService.getEntryTransferHistory", () => {
	it("builds transfer history from Redis player/team/live data", async () => {
		const originalGetEntryTransferHistory =
			entryLiveRepository.getEntryTransferHistory;
		const transferRows: EntryEventTransferRow[] = [
			{
				entryId: 84885,
				eventId: 12,
				elementIn: 1,
				elementOut: 2,
				time: "2026-01-01T00:00:00Z",
			},
		];

		entryLiveRepository.getEntryTransferHistory = async (): Promise<
			EntryEventTransferRow[]
		> => transferRows;

		const liveData: Record<string, string> = {
			"1": JSON.stringify({
				eventId: 12,
				element_id: 1,
				totalPoints: 8,
				minutes: 90,
			}),
			"2": JSON.stringify({
				eventId: 12,
				element_id: 2,
				totalPoints: 2,
				minutes: 0,
			}),
		};

		const context = makeContext({
			season: "2526",
			players: { "1": PLAYER_1, "2": PLAYER_2 },
			teams: { "1": TEAM_1, "2": TEAM_2 },
			eventLive: { "EventLive:2526:12": liveData },
		});

		try {
			const result = await entriesService.getEntryTransferHistory(
				context,
				84885,
				true,
			);
			expect(result).toHaveLength(1);
			expect(result[0].eventId).toBe(12);
			expect(result[0].eventTransfers).toBe(1);
			expect(result[0].eventTransfersCost).toBe(0);
			expect(result[0].transfers[0]).toMatchObject({
				event: 12,
				elementInWebName: "Saka",
				elementInTeamShortName: "ARS",
				elementInPoints: 8,
				elementInPlayed: true,
				elementOutWebName: "Salah",
				elementOutTeamShortName: "LIV",
				elementOutPoints: 2,
			});
		} finally {
			entryLiveRepository.getEntryTransferHistory =
				originalGetEntryTransferHistory;
		}
	});
});

describe("entriesService.getEntryEventPicks", () => {
	it("enriches stored compact picks from Redis player/team/live data", async () => {
		const eventResult: EntryEventResult = {
			entryId: 84885,
			eventId: 34,
			eventPoints: 65,
			eventRank: 1000,
			overallPoints: 1900,
			overallRank: 2000,
			eventTransfers: 1,
			eventTransfersCost: 0,
			eventNetPoints: 65,
			eventBenchPoints: 6,
			eventChip: null,
			eventPlayedCaptain: 449,
			eventCaptainPoints: 20,
			eventPicks: [
				{
					element: 449,
					position: 7,
					multiplier: 2,
					is_captain: true,
					is_vice_captain: false,
				},
				{
					element: 470,
					position: 12,
					multiplier: 0,
					is_captain: false,
					is_vice_captain: false,
				},
			],
			teamValue: 1020,
			bank: 5,
		};

		const PLAYER_449 = JSON.stringify({
			webName: "Gyokeres",
			type: 4,
			teamId: 1,
			code: 449,
			price: 75,
		});
		const PLAYER_470 = JSON.stringify({
			webName: "Dubravka",
			type: 1,
			teamId: 1,
			code: 470,
			price: 50,
		});
		const TEAM_1_FOR_PICKS = JSON.stringify({
			id: 1,
			code: 3,
			name: "Arsenal",
			shortName: "ARS",
		});

		const liveData34: Record<string, string> = {
			"449": JSON.stringify({
				eventId: 34,
				element_id: 449,
				totalPoints: 10,
				minutes: 90,
			}),
			"470": JSON.stringify({
				eventId: 34,
				element_id: 470,
				totalPoints: 2,
				minutes: 0,
			}),
		};

		const context = makeContext({
			season: "2526",
			players: { "449": PLAYER_449, "470": PLAYER_470 },
			teams: { "1": TEAM_1_FOR_PICKS },
			eventLive: { "EventLive:2526:34": liveData34 },
		});

		const result = await entriesService.getEntryEventPicks(
			context,
			eventResult,
		);
		expect(result).toHaveLength(2);
		expect(result[0]).toMatchObject({
			webName: "Gyokeres",
			teamShortName: "ARS",
			teamName: "Arsenal",
			elementTypeName: "FWD",
			isCaptain: true,
			isViceCaptain: false,
			multiplier: 2,
			totalPoints: 10,
			minutes: 90,
			position: 7,
		});
		expect(result[1]).toMatchObject({
			webName: "Dubravka",
			elementTypeName: "GKP",
			totalPoints: 2,
			minutes: 0,
			position: 12,
		});
	});
});
