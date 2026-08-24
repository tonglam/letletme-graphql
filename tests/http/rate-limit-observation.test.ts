import { describe, expect, it } from "bun:test";
import { capacityRunRequestIdPrefix } from "../../src/http/capacity-run-id";
import {
	buildRateLimitTargetObservation,
	buildRateLimitTargetObservationV4,
	parseCapacityLoadReport,
} from "../../src/http/rate-limit-observation";

const startedAt = Date.parse("2026-08-20T00:00:00.000Z");
const finishedAt = startedAt + 15 * 60 * 1000;
const report = {
	runId: "capacity-run-123",
	gatePassed: true,
	model: { targetConcurrent: 300, stagesSeconds: { sustainability: 300 } },
	summary: { sustainableRps: 40 },
	window: {
		stageWindows: [{ concurrent: 300, startedAt, finishedAt, serverGraphQLRequests: 4 }],
	},
	sustainability: [
		{
			phase: "stage-300",
			multiplier: 1,
			durationSeconds: 900,
			elapsedSeconds: 900,
			achievedGraphQLRps: 20,
			passed: true,
		},
		{
			phase: "sustainable-2x",
			multiplier: 2,
			durationSeconds: 300,
			elapsedSeconds: 300,
			achievedGraphQLRps: 40.4,
			passed: true,
		},
	],
};

const log = (input: Record<string, unknown>): string =>
	JSON.stringify({
		time: startedAt + 1_000,
		msg: "GraphQL v3 rate-limit decision",
		stage: "weighted",
		policy: "graphql-v3",
		requestId: `${capacityRunRequestIdPrefix(report.runId)}request-1`,
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
				log({
					requestId: `${capacityRunRequestIdPrefix(`${report.runId}-2`)}request-1`,
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
		expect(observation.webRsc.workloadMaxCost["player-stats"]).toBe(20);
		expect(observation.webRsc.workloadMaxCost.fixtures).toBe(10);
		expect(observation.webRsc.workloadMaxCost.market).toBe(0);
		expect(observation.service).toEqual({
			classRequestPerSecond: 1 / 900,
			weightedPerSecond: 8 / 900,
			maxWeightedCost: 8,
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
						stageWindows: [
							{
								concurrent: 300,
								startedAt,
								finishedAt: startedAt + 1_000,
								serverGraphQLRequests: 1,
							},
						],
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
		).toThrow("coverage mismatch");
	});

	it("rejects truncated decision logs instead of undersizing class buckets", () => {
		expect(() =>
			buildRateLimitTargetObservation({
				report,
				logLines: [log({ trafficClass: "mini", workload: "home", cost: 1 })],
			})
		).toThrow("expected 4, matched 1");
	});

	it("rejects short configured or elapsed sustainability probes", () => {
		expect(() =>
			buildRateLimitTargetObservation({
				report: {
					...report,
					model: { targetConcurrent: 300, stagesSeconds: { sustainability: 1 } },
				},
				logLines: [],
			})
		).toThrow("five-minute sustainability probes");

		expect(() =>
			buildRateLimitTargetObservation({
				report: {
					...report,
					sustainability: report.sustainability.map((phase) =>
						phase.phase === "sustainable-2x" ? { ...phase, elapsedSeconds: 1 } : phase
					),
				},
				logLines: [],
			})
		).toThrow("complete five-minute probes");
	});

	it("parses the completeness fields required by profile generation", () => {
		expect(parseCapacityLoadReport(report)).toEqual(report);
		expect(() =>
			parseCapacityLoadReport({
				...report,
				window: {
					stageWindows: [{ concurrent: 300, startedAt, finishedAt }],
				},
			})
		).toThrow("invalid stage window");
	});

	it("derives separate anonymous and authenticated Mini workload evidence for v4", () => {
		const v4Log = (input: Record<string, unknown>): string =>
			JSON.stringify({
				time: startedAt + 1_000,
				msg: "GraphQL v4 rate-limit decision",
				stage: "weighted",
				policy: "graphql-v4",
				requestId: `${capacityRunRequestIdPrefix(report.runId)}request-v4`,
				allowed: true,
				...input,
			});
		const observation = buildRateLimitTargetObservationV4({
			report: {
				...report,
				window: {
					...report.window,
					stageWindows: [{ ...report.window.stageWindows[0]!, serverGraphQLRequests: 6 }],
				},
			},
			logLines: [
				v4Log({
					trafficClass: "mini",
					workload: "fixtures",
					audience: "anonymous",
					fingerprint: "aaaaaaaaaaaa",
					cost: 5,
				}),
				v4Log({
					trafficClass: "mini",
					workload: "fixtures",
					audience: "anonymous",
					fingerprint: "aaaaaaaaaaaa",
					cost: 3,
				}),
				v4Log({
					trafficClass: "mini",
					workload: "fixtures",
					audience: "anonymous",
					fingerprint: "bbbbbbbbbbbb",
					cost: 4,
				}),
				v4Log({
					trafficClass: "mini",
					workload: "player-stats",
					audience: "authenticated",
					fingerprint: "cccccccccccc",
					cost: 40,
				}),
				v4Log({ trafficClass: "web_rsc", workload: "fixtures", cost: 10 }),
				v4Log({ trafficClass: "service", workload: "public-other", cost: 8 }),
			],
		});
		expect(observation.mini.anonymousWeightedPerSecond.fixtures).toBe(8 / 900);
		expect(observation.mini.anonymousMaxCost.fixtures).toBe(5);
		expect(observation.mini.sessionWeightedPerSecond["player-stats"]).toBe(40 / 900);
		expect(observation.mini.sessionMaxCost["player-stats"]).toBe(40);
		expect(() =>
			buildRateLimitTargetObservationV4({
				report,
				logLines: [
					v4Log({
						trafficClass: "mini",
						workload: "fixtures",
						audience: "anonymous",
						cost: 5,
					}),
					v4Log({
						trafficClass: "mini",
						workload: "player-stats",
						audience: "authenticated",
						fingerprint: "cccccccccccc",
						cost: 40,
					}),
					v4Log({ trafficClass: "web_rsc", workload: "fixtures", cost: 10 }),
					v4Log({ trafficClass: "service", workload: "public-other", cost: 8 }),
				],
			})
		).toThrow("identity fingerprints");
	});
});
