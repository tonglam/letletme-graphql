import { describe, expect, it } from "bun:test";
import type Redis from "ioredis";
import {
	rateLimitAggregateMinute,
	rateLimitFingerprint,
	rateLimitRecentAggregateKey,
	recordRateLimitAggregate,
	summarizeRateLimitTotals,
} from "../../src/infra/rate-limit-observability";
import { GRAPHQL_REQUEST_OUTCOME_LABELS } from "../../src/infra/metrics";

describe("rate-limit observability privacy", () => {
	it("creates a stable twelve-character HMAC fingerprint", () => {
		const first = rateLimitFingerprint("raw-device-id", "test-secret");
		const second = rateLimitFingerprint("raw-device-id", "test-secret");
		expect(first).toBe(second);
		expect(first).toMatch(/^[a-f0-9]{12}$/);
		expect(first).not.toContain("raw-device-id");
	});

	it("uses bounded minute keys for recent rollout monitoring", () => {
		const minute = rateLimitAggregateMinute(new Date("2026-08-20T12:34:56.000Z"));
		expect(minute).toBe("2026-08-20T12:34");
		expect(rateLimitRecentAggregateKey(minute)).toBe(
			"llm:gql:rate-limit:v3:recent:2026-08-20T12:34"
		);
	});

	it("stores only controlled dimensions and denied fingerprints", async () => {
		const commands: unknown[][] = [];
		const pipeline = {
			hincrby: (...args: unknown[]) => commands.push(["hincrby", ...args]),
			expire: (...args: unknown[]) => commands.push(["expire", ...args]),
			zincrby: (...args: unknown[]) => commands.push(["zincrby", ...args]),
			exec: async () => commands.map(() => [null, 1]),
		};
		const redis = { pipeline: () => pipeline } as unknown as Redis;
		await recordRateLimitAggregate({
			redis,
			trafficClass: "mini",
			workload: "market",
			scope: "client",
			outcome: "denied",
			fingerprint: "abc123abc123",
			date: new Date("2026-08-20T00:00:00.000Z"),
			logger: { warn: () => undefined } as never,
		});
		const serialized = JSON.stringify(commands);
		expect(serialized).toContain("mini|market|client|denied");
		expect(serialized).toContain("llm:gql:rate-limit:v3:recent:2026-08-20T00:00");
		expect(serialized).toContain("abc123abc123");
		expect(serialized).not.toContain("raw-device-id");
	});

	it("does not create a fingerprint ranking for allowed traffic", async () => {
		const commands: unknown[][] = [];
		const pipeline = {
			hincrby: (...args: unknown[]) => commands.push(["hincrby", ...args]),
			expire: (...args: unknown[]) => commands.push(["expire", ...args]),
			zincrby: (...args: unknown[]) => commands.push(["zincrby", ...args]),
			exec: async () => commands.map(() => [null, 1]),
		};
		await recordRateLimitAggregate({
			redis: { pipeline: () => pipeline } as unknown as Redis,
			trafficClass: "web_rsc",
			workload: "fixtures",
			scope: "workload",
			outcome: "allowed",
			fingerprint: "abc123abc123",
			logger: { warn: () => undefined } as never,
		});
		expect(commands.some(([command]) => command === "zincrby")).toBe(false);
	});

	it("exports GraphQL outcomes with only one controlled result dimension", () => {
		expect(GRAPHQL_REQUEST_OUTCOME_LABELS).toEqual(["result"]);
	});

	it("reports enforced and shadow rollout alarms independently", () => {
		const summary = summarizeRateLimitTotals(
			new Map([
				["mini|market|client|legacy_allowed", 90],
				["mini|market|client|legacy_denied", 10],
				["mini|market|client|would_allow", 60],
				["mini|market|client|would_deny", 40],
				["mini|market|global|would_deny", 2],
			])
		);
		expect(summary.interactiveDeniedRate).toBe(0.1);
		expect(summary.totalDecisions).toBe(202);
		expect(summary.shadowInteractiveDeniedRate).toBe(42 / 102);
		expect(summary.globalDenied).toBe(0);
		expect(summary.globalWouldDenied).toBe(2);
	});
});
