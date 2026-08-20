import { GRAPHQL_TRAFFIC_CLASSES, GRAPHQL_WORKLOADS } from "../infra/ingress-envelope";
import type { RateLimitTargetObservation } from "./rate-limit-profile-generator";

export type CapacityLoadReport = {
	runId: string;
	gatePassed: boolean;
	model: { targetConcurrent: number };
	summary: { sustainableRps: number };
	window: {
		stageWindows: readonly {
			concurrent: number;
			startedAt: number;
			finishedAt: number;
		}[];
	};
};

const isFiniteNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

export const parseCapacityLoadReport = (value: unknown): CapacityLoadReport => {
	if (!value || typeof value !== "object") throw new Error("Load report must be an object");
	const candidate = value as Record<string, unknown>;
	const model = candidate.model;
	const summary = candidate.summary;
	const window = candidate.window;
	if (
		typeof candidate.runId !== "string" ||
		!/^[A-Za-z0-9_-]{8,32}$/.test(candidate.runId) ||
		typeof candidate.gatePassed !== "boolean" ||
		!model ||
		typeof model !== "object" ||
		(model as Record<string, unknown>).targetConcurrent !== 300 ||
		!summary ||
		typeof summary !== "object" ||
		!Number.isSafeInteger((summary as Record<string, unknown>).sustainableRps) ||
		((summary as Record<string, unknown>).sustainableRps as number) < 0 ||
		!window ||
		typeof window !== "object" ||
		!Array.isArray((window as Record<string, unknown>).stageWindows)
	) {
		throw new Error("Load report does not match the capacity evidence schema");
	}
	const stageWindows = (window as Record<string, unknown>).stageWindows as unknown[];
	if (
		!stageWindows.every((entry) => {
			if (!entry || typeof entry !== "object") return false;
			const stage = entry as Record<string, unknown>;
			return (
				isFiniteNumber(stage.concurrent) &&
				isFiniteNumber(stage.startedAt) &&
				isFiniteNumber(stage.finishedAt)
			);
		})
	) {
		throw new Error("Load report contains an invalid stage window");
	}
	return {
		runId: candidate.runId,
		gatePassed: candidate.gatePassed,
		model: { targetConcurrent: 300 },
		summary: {
			sustainableRps: (summary as Record<string, number>).sustainableRps,
		},
		window: {
			stageWindows: stageWindows as CapacityLoadReport["window"]["stageWindows"],
		},
	};
};

type V3DecisionLog = {
	time?: unknown;
	requestId?: unknown;
	msg?: unknown;
	stage?: unknown;
	policy?: unknown;
	trafficClass?: unknown;
	workload?: unknown;
	cost?: unknown;
	allowed?: unknown;
};

const timestampMs = (value: unknown): number | null => {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
};

const parseDecision = (line: string): V3DecisionLog | null => {
	try {
		const parsed = JSON.parse(line) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as V3DecisionLog) : null;
	} catch {
		return null;
	}
};

export const buildRateLimitTargetObservation = ({
	report,
	logLines,
}: {
	report: CapacityLoadReport;
	logLines: readonly string[];
}): RateLimitTargetObservation => {
	if (!report.gatePassed || report.model.targetConcurrent !== 300) {
		throw new Error("Load report must pass the exact 300-concurrent capacity gates");
	}
	if (!Number.isSafeInteger(report.summary.sustainableRps) || report.summary.sustainableRps < 2) {
		throw new Error("Load report must contain an automatically measured sustainable RPS");
	}
	const window = report.window.stageWindows.find((candidate) => candidate.concurrent === 300);
	if (!window || window.finishedAt - window.startedAt < 15 * 60 * 1000) {
		throw new Error("Capacity evidence requires a complete fifteen-minute 300-concurrent stage");
	}
	const durationSeconds = (window.finishedAt - window.startedAt) / 1000;
	const requestIdPrefix = `${report.runId}-`;
	const workloads = Object.fromEntries(
		GRAPHQL_WORKLOADS.map((workload) => [workload, 0])
	) as Record<(typeof GRAPHQL_WORKLOADS)[number], number>;
	let totalRequests = 0;
	let rscRequests = 0;
	let serviceRequests = 0;
	let serviceWeighted = 0;

	for (const line of logLines) {
		const decision = parseDecision(line);
		const at = timestampMs(decision?.time);
		if (
			!decision ||
			at === null ||
			at < window.startedAt ||
			at > window.finishedAt ||
			decision.msg !== "GraphQL v3 rate-limit decision" ||
			typeof decision.requestId !== "string" ||
			!decision.requestId.startsWith(requestIdPrefix) ||
			decision.stage !== "weighted" ||
			decision.policy !== "graphql-v3" ||
			decision.allowed !== true ||
			!GRAPHQL_TRAFFIC_CLASSES.includes(
				decision.trafficClass as (typeof GRAPHQL_TRAFFIC_CLASSES)[number]
			) ||
			!GRAPHQL_WORKLOADS.includes(decision.workload as (typeof GRAPHQL_WORKLOADS)[number]) ||
			typeof decision.cost !== "number" ||
			!Number.isSafeInteger(decision.cost) ||
			decision.cost < 1
		) {
			continue;
		}
		totalRequests += 1;
		if (decision.trafficClass === "web_rsc") {
			rscRequests += 1;
			workloads[decision.workload as (typeof GRAPHQL_WORKLOADS)[number]] += decision.cost;
		}
		if (decision.trafficClass === "service") {
			serviceRequests += 1;
			serviceWeighted += decision.cost;
		}
	}

	if (totalRequests === 0) {
		throw new Error("No weighted v3 decisions matched the 300-concurrent evidence window");
	}
	return {
		targetConcurrent: 300,
		sustainableRps: report.summary.sustainableRps,
		totalRequestPerSecond: totalRequests / durationSeconds,
		webRsc: {
			classRequestPerSecond: rscRequests / durationSeconds,
			workloadWeightedPerSecond: Object.fromEntries(
				Object.entries(workloads).map(([workload, units]) => [workload, units / durationSeconds])
			) as Record<(typeof GRAPHQL_WORKLOADS)[number], number>,
		},
		service: {
			classRequestPerSecond: serviceRequests / durationSeconds,
			weightedPerSecond: serviceWeighted / durationSeconds,
		},
	};
};
