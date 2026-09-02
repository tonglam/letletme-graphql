import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";

import {
	readH2HLeagueHeadV2,
	readH2HLeagueMembershipV2,
	readH2HLeaguePublicationV2,
} from "../../../src/domains/live-desks/h2h-v2";
import { buildSnapshotContext, TestRedis } from "../../helpers/data-publication";

const canonical = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value as Record<string, unknown>)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
};

const hash = (value: unknown): string =>
	createHash("sha256").update(canonical(value), "utf8").digest("hex");

describe("H2H V2 publication reader", () => {
	it("retains a pending real side and an Average side in the same match", async () => {
		const season = "2627";
		const eventId = 1;
		const tournamentId = 7;
		const generation = 1;
		const base = `llm:data:v2:fpl:league-live:${season}:${eventId}:${tournamentId}:h2h-head`;
		const indexKey = `${base}:${generation}:index`;
		const payloadKey = `${base}:${generation}:payload`;
		const publicationId = "00000000-0000-4000-8000-000000000001";
		const sourceCheckedAt = "2026-08-30T00:00:00.000Z";
		const revisions = {
			roster: "1".repeat(64),
			scoreCore: "2".repeat(64),
			fixtureIdentity: "3".repeat(64),
			entryInputSet: "4".repeat(64),
			identity: "5".repeat(64),
			officialRank: null,
			rules: "6".repeat(64),
			algorithm: "7".repeat(64),
			schedule: "8".repeat(64),
			averageSide: "9".repeat(64),
			content: "a".repeat(64),
		};
		const index = [
			{
				matchId: 1,
				eventId,
				groupId: 1,
				sourceOrder: 0,
				phase: "REGULAR" as const,
				availability: "PENDING" as const,
				homeEntryId: 101,
				awayEntryId: null,
			},
		];
		const pendingSide = {
			entryId: 101,
			entryName: "Entry 101",
			playerName: "Manager",
			isAverage: false,
			officialNetPoints: null,
			inputPublicationId: null,
			inputGeneration: null,
			inputRevision: null,
			inputContentUpdatedAt: null,
			input: null,
		};
		const averageSide = {
			entryId: null,
			entryName: "Average",
			playerName: null,
			isAverage: true,
			officialNetPoints: null,
			inputPublicationId: null,
			inputGeneration: null,
			inputRevision: null,
			inputContentUpdatedAt: null,
			input: null,
		};
		const payload = {
			"1": {
				contractVersion: "live-points-v2",
				season,
				eventId,
				tournamentId,
				officialMatchId: 1,
				groupId: 1,
				sourceOrder: 0,
				phase: "REGULAR",
				knockoutName: null,
				tiebreak: null,
				isBye: false,
				state: "PENDING",
				sourceCheckedAt,
				globalRef: { publicationId, generation },
				home: pendingSide,
				away: averageSide,
			},
		};
		const indexRaw = JSON.stringify(index);
		const payloadRaw = JSON.stringify(payload);
		const manifest = {
			contractVersion: "live-points-v2",
			publicationId: "00000000-0000-4000-8000-000000000002",
			generation,
			season,
			eventId,
			tournamentId,
			scope: "H2H_HEAD",
			state: "LIVE_ACTIVE",
			globalRef: { publicationId, generation },
			revisions,
			times: {
				sourceCheckedAt,
				contentUpdatedAt: sourceCheckedAt,
				publishedAt: sourceCheckedAt,
				checkpointedAt: null,
				expectedNextCheckAt: "2026-08-30T00:00:30.000Z",
			},
			counts: { expected: 1, published: 1, ready: 0, noPicks: 0 },
			items: {
				index: {
					name: "index",
					key: indexKey,
					type: "string",
					count: 1,
					bytes: Buffer.byteLength(indexRaw, "utf8"),
					sha256: hash(index),
				},
				payload: {
					name: "payload",
					key: payloadKey,
					type: "string",
					count: 1,
					bytes: Buffer.byteLength(payloadRaw, "utf8"),
					sha256: hash(payload),
				},
			},
		};
		const redis = new TestRedis();
		redis.values.set(`${base}:active`, JSON.stringify(manifest));
		redis.values.set(indexKey, indexRaw);
		redis.values.set(`${indexKey}:meta`, `1|${Buffer.byteLength(indexRaw, "utf8")}|${hash(index)}`);
		redis.values.set(payloadKey, payloadRaw);
		redis.values.set(
			`${payloadKey}:meta`,
			`1|${Buffer.byteLength(payloadRaw, "utf8")}|${hash(payload)}`
		);
		redis.values.set(payloadKey, payloadRaw.replace("00:00:00.000Z", "00:00:01.000Z"));
		const corruptHead = await readH2HLeagueHeadV2(
			buildSnapshotContext(redis),
			tournamentId,
			eventId
		);
		expect(corruptHead).toBeNull();
		redis.values.set(payloadKey, payloadRaw);

		const read = await readH2HLeaguePublicationV2(
			buildSnapshotContext(redis),
			tournamentId,
			eventId,
			"H2H_HEAD"
		);

		expect(read?.servedFrom).toBe("REDIS_CURRENT");
		expect(read?.index).toEqual(index);
		expect((read?.payload["1"] as { state: string }).state).toBe("PENDING");
	});

	it("uses the standings roster when a member has no current matchup", async () => {
		const season = "2627";
		const eventId = 1;
		const tournamentId = 8;
		const generation = 1;
		const base = `llm:data:v2:fpl:league-live:${season}:${eventId}:${tournamentId}:h2h-standings`;
		const index = [{ entryId: 101, availability: "READY" as const }];
		const payload = { standings: {} };
		const indexRaw = JSON.stringify(index);
		const payloadRaw = JSON.stringify(payload);
		const redis = new TestRedis();
		redis.values.set(
			`${base}:active`,
			JSON.stringify({
				contractVersion: "live-points-v2",
				publicationId: "00000000-0000-4000-8000-000000000008",
				generation,
				season,
				eventId,
				tournamentId,
				scope: "H2H_STANDINGS",
				state: "LIVE_ACTIVE",
				globalRef: {
					publicationId: "00000000-0000-4000-8000-000000000001",
					generation,
				},
				revisions: {
					roster: "1".repeat(64),
					scoreCore: "2".repeat(64),
					fixtureIdentity: "3".repeat(64),
					entryInputSet: "4".repeat(64),
					identity: "5".repeat(64),
					officialRank: null,
					rules: "6".repeat(64),
					algorithm: "7".repeat(64),
					schedule: "8".repeat(64),
					averageSide: null,
					content: "9".repeat(64),
				},
				times: {
					sourceCheckedAt: "2026-08-30T00:00:00.000Z",
					contentUpdatedAt: "2026-08-30T00:00:00.000Z",
					publishedAt: "2026-08-30T00:00:00.000Z",
					checkpointedAt: null,
					expectedNextCheckAt: "2026-08-30T00:00:30.000Z",
				},
				counts: { expected: 1, published: 1, ready: 1, noPicks: 0 },
				items: {
					index: {
						name: "index",
						key: `${base}:${generation}:index`,
						type: "string",
						count: 1,
						bytes: Buffer.byteLength(indexRaw, "utf8"),
						sha256: hash(index),
					},
					payload: {
						name: "payload",
						key: `${base}:${generation}:payload`,
						type: "string",
						count: 1,
						bytes: Buffer.byteLength(payloadRaw, "utf8"),
						sha256: hash(payload),
					},
				},
			})
		);
		redis.values.set(`${base}:1:index`, indexRaw);
		redis.values.set(
			`${base}:1:index:meta`,
			`1|${Buffer.byteLength(indexRaw, "utf8")}|${hash(index)}`
		);
		redis.values.set(`${base}:1:payload`, payloadRaw);
		redis.values.set(
			`${base}:1:payload:meta`,
			`1|${Buffer.byteLength(payloadRaw, "utf8")}|${hash(payload)}`
		);

		expect(
			await readH2HLeagueMembershipV2(buildSnapshotContext(redis), tournamentId, eventId, 101)
		).toBe(true);
	});
});
