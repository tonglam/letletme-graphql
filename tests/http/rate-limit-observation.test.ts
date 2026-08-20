import { describe, expect, it } from "bun:test";
import { buildRateLimitTargetObservation } from "../../src/http/rate-limit-observation";

const startedAt = Date.parse("2026-08-20T00:00:00.000Z");
const finishedAt = startedAt + 15 * 60 * 1000;
const report = {
	runId: "capacity-run-123",
	gatePassed: true,
	model: { targetConcurrent: 300 },
	summary: { sustainableRps: 40 },
	window: {
		stageWindows: [{ concurrent: 300, startedAt, finishedAt }],
	},
};

const log = (input: Record<string, unknown>): string =>
	JSON.stringify({
		time: startedAt + 1_000,
		msg: "GraphQL v3 rate-limit decision",
		stage: "weighted",
		policy: "graphql-v3",
		requestId: "capacity-run-123-request-1",
		allowed: true,
		...input,
	});

describe("capacity log observation", () => {
	it("derives request and weighted workload rates from the exact 300 stage", () => {
		const observation = buildRateLimitTargetObservation({
			report,
			logLines: [
				log({
					requestId: "another-run-request-1",
					trafficClass: "mini",
					workload: "home",
					cost: 50,
				}),
				log({ trafficClass: "mini", workload: "market", cost: 4 }),
				log({ trafficClass: "web_rsc", workload: "player-stats", cost: 20 }),
				log({ trafficClass: "web_rsc", workload: "fixtures", cost: 10 }),
				log({ trafficClass: "service", workload: "public-other", cost: 8 }),
			],
		});
		expect(observation.totalRequestPerSecond).toBe(4 / 900);
		expect(observation.sustainableRps).toBe(40);
		expect(observation.webRsc.classRequestPerSecond).toBe(2 / 900);
		expect(observation.webRsc.workloadWeightedPerSecond["player-stats"]).toBe(20 / 900);
		expect(observation.webRsc.workloadWeightedPerSecond.fixtures).toBe(10 / 900);
		expect(observation.service).toEqual({
			classRequestPerSecond: 1 / 900,
			weightedPerSecond: 8 / 900,
		});
	});

	it("rejects failed or shortened evidence and ignores malformed/out-of-window logs", () => {
		expect(() =>
			buildRateLimitTargetObservation({
				report: { ...report, gatePassed: false },
				logLines: [],
			})
		).toThrow("must pass");
		expect(() =>
			buildRateLimitTargetObservation({
				report: {
					...report,
					window: {
						stageWindows: [{ concurrent: 300, startedAt, finishedAt: startedAt + 1_000 }],
					},
				},
				logLines: [],
			})
		).toThrow("fifteen-minute");
		expect(() =>
			buildRateLimitTargetObservation({
				report,
				logLines: [
					"not json",
					log({ time: finishedAt + 1, trafficClass: "mini", workload: "home", cost: 1 }),
				],
			})
		).toThrow("No weighted v3 decisions");
	});
});
