import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";

import {
	liveDeliveryFreshnessStateV2,
	readLeagueLiveHeadV2,
	readLeagueLivePublicationV2,
} from "../../../src/domains/live-desks/league-v2";
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

const buildRedis = (
	tournamentId: number,
	state: "LIVE_ACTIVE" | "FINALIZED",
	finalized: boolean
) => {
	const season = "2627";
	const eventId = 1;
	const generation = 1;
	const base = `llm:data:v2:fpl:league-live:${season}:${eventId}:${tournamentId}:classic`;
	const indexKey = `${base}:${generation}:index`;
	const payloadKey = `${base}:${generation}:payload`;
	const sourceCheckedAt = "2026-08-30T00:00:00.000Z";
	const publicationId = `00000000-0000-4000-8000-${String(tournamentId).padStart(12, "0")}`;
	const picks = Array.from({ length: 15 }, (_, index) => ({
		element: index + 1,
		position: index + 1,
		multiplier: index === 0 ? 2 : 1,
		isCaptain: index === 0,
		isViceCaptain: index === 1,
	}));
	const input = {
		contractVersion: "live-points-v2" as const,
		season,
		eventId,
		entryId: 101,
		picksBase: {
			revision: "1".repeat(64),
			contentUpdatedAt: sourceCheckedAt,
			picks,
			chip: null,
			transferCost: 0,
		},
		previousTotals: null,
		officialAdjustment: null,
		finalResult: finalized
			? {
					revision: "2".repeat(64),
					score: { eventPoints: 42, totalPoints: 142 },
					picks,
					automaticSubs: [],
				}
			: null,
	};
	const index = [
		{
			entryId: input.entryId,
			availability: "READY" as const,
			entryName: "Entry 101",
			playerName: "Manager",
			region: null,
			startedEvent: null,
			overallPoints: 100,
			overallRank: 10,
			bank: 0,
			teamValue: 1000,
			totalTransfers: 0,
			lastEventId: null,
			lastOverallPoints: null,
			lastOverallRank: null,
			lastTeamValue: null,
			lastBank: null,
			inputPublicationId: publicationId,
			inputGeneration: generation,
			inputRevision: hash(input),
			inputContentUpdatedAt: sourceCheckedAt,
		},
	];
	const payload = { "101": input };
	const indexRaw = JSON.stringify(index);
	const payloadRaw = JSON.stringify(payload);
	const revisions = {
		roster: "a".repeat(64),
		scoreCore: "b".repeat(64),
		fixtureIdentity: "c".repeat(64),
		entryInputSet: "d".repeat(64),
		identity: "e".repeat(64),
		officialRank: "9".repeat(64),
		rules: "f".repeat(64),
		algorithm: "0".repeat(64),
		schedule: null,
		averageSide: null,
		content: "1".repeat(64),
	};
	const manifest = {
		contractVersion: "live-points-v2",
		publicationId,
		generation,
		season,
		eventId,
		tournamentId,
		scope: "CLASSIC",
		state,
		globalRef: { publicationId: "00000000-0000-4000-8000-000000000099", generation },
		revisions,
		times: {
			sourceCheckedAt,
			contentUpdatedAt: sourceCheckedAt,
			publishedAt: sourceCheckedAt,
			checkpointedAt: finalized ? sourceCheckedAt : null,
			expectedNextCheckAt: sourceCheckedAt,
		},
		counts: { expected: 1, published: 1, ready: 1, noPicks: 0 },
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
	redis.values.set(payloadKey, payloadRaw);
	redis.values.set(`${indexKey}:meta`, `1|${Buffer.byteLength(indexRaw, "utf8")}|${hash(index)}`);
	redis.values.set(
		`${payloadKey}:meta`,
		`1|${Buffer.byteLength(payloadRaw, "utf8")}|${hash(payload)}`
	);
	return { redis, season, eventId, tournamentId };
};

describe("Classic live league publication lifecycle fence", () => {
	it("accepts only matching finalResult state for the publication lifecycle", async () => {
		const provisional = buildRedis(31, "LIVE_ACTIVE", false);
		const provisionalRead = await readLeagueLivePublicationV2(
			buildSnapshotContext(provisional.redis),
			{
				season: provisional.season,
				eventId: provisional.eventId,
				tournamentId: provisional.tournamentId,
				mode: "CLASSIC",
			}
		);
		expect(provisionalRead?.servedFrom).toBe("REDIS_CURRENT");

		const finalizedWithoutResult = buildRedis(32, "FINALIZED", false);
		const finalizedWithoutResultRead = await readLeagueLivePublicationV2(
			buildSnapshotContext(finalizedWithoutResult.redis),
			{
				season: finalizedWithoutResult.season,
				eventId: finalizedWithoutResult.eventId,
				tournamentId: finalizedWithoutResult.tournamentId,
				mode: "CLASSIC",
			}
		);
		expect(finalizedWithoutResultRead).toBeNull();

		const finalized = buildRedis(33, "FINALIZED", true);
		const finalizedRead = await readLeagueLivePublicationV2(buildSnapshotContext(finalized.redis), {
			season: finalized.season,
			eventId: finalized.eventId,
			tournamentId: finalized.tournamentId,
			mode: "CLASSIC",
		});
		expect(finalizedRead?.servedFrom).toBe("REDIS_CURRENT");

		const provisionalWithFinal = buildRedis(34, "LIVE_ACTIVE", true);
		const provisionalWithFinalRead = await readLeagueLivePublicationV2(
			buildSnapshotContext(provisionalWithFinal.redis),
			{
				season: provisionalWithFinal.season,
				eventId: provisionalWithFinal.eventId,
				tournamentId: provisionalWithFinal.tournamentId,
				mode: "CLASSIC",
			}
		);
		expect(provisionalWithFinalRead).toBeNull();
	});

	it("does not advertise a head when the payload body is missing", async () => {
		const fixture = buildRedis(35, "LIVE_ACTIVE", false);
		fixture.redis.values.delete(
			`llm:data:v2:fpl:league-live:${fixture.season}:${fixture.eventId}:${fixture.tournamentId}:classic:1:payload`
		);

		const head = await readLeagueLiveHeadV2(buildSnapshotContext(fixture.redis), {
			season: fixture.season,
			eventId: fixture.eventId,
			tournamentId: fixture.tournamentId,
			mode: "CLASSIC",
		});

		expect(head).toBeNull();
	});

	it("does not advertise a head when the payload hash is stale", async () => {
		const fixture = buildRedis(36, "LIVE_ACTIVE", false);
		const payloadKey = `llm:data:v2:fpl:league-live:${fixture.season}:${fixture.eventId}:${fixture.tournamentId}:classic:1:payload`;
		const payload = fixture.redis.values.get(payloadKey);
		expect(payload).toBeDefined();
		fixture.redis.values.set(payloadKey, payload!.replace('"transferCost":0', '"transferCost":1'));

		const head = await readLeagueLiveHeadV2(buildSnapshotContext(fixture.redis), {
			season: fixture.season,
			eventId: fixture.eventId,
			tournamentId: fixture.tournamentId,
			mode: "CLASSIC",
		});

		expect(head).toBeNull();
	});
});

describe("live league freshness state", () => {
	const times = {
		sourceCheckedAt: "2026-08-30T00:00:00.000Z",
		nextRefreshAt: "2026-08-30T00:00:30.000Z",
		staleAt: "2026-08-30T00:00:37.500Z",
	};

	it("moves from fresh to stale to degraded without expiring availability", () => {
		expect(liveDeliveryFreshnessStateV2(times, Date.parse("2026-08-30T00:00:30.000Z"))).toBe(
			"FRESH"
		);
		expect(liveDeliveryFreshnessStateV2(times, Date.parse("2026-08-30T00:00:45.000Z"))).toBe(
			"STALE"
		);
		expect(liveDeliveryFreshnessStateV2(times, Date.parse("2026-08-30T00:01:01.000Z"))).toBe(
			"DEGRADED"
		);
	});
});
