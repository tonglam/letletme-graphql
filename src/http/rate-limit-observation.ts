import { GRAPHQL_TRAFFIC_CLASSES, GRAPHQL_WORKLOADS } from "../infra/ingress-envelope";
import { capacityRunRequestIdPrefix } from "./capacity-run-id";
import type { RateLimitTargetObservation } from "./rate-limit-profile-generator";

export type CapacityLoadReport = {
	runId: string;
	gatePassed: boolean;
	model: {
		targetConcurrent: number;
		stagesSeconds: { sustainability: number };
	};
	summary: { sustainableRps: number };
	window: {
		stageWindows: readonly {
			concurrent: number;
			startedAt: number;
			finishedAt: number;
			serverGraphQLRequests: number;
		}[];
	};
	sustainability: readonly {
		phase: string;
		multiplier: number;
		durationSeconds: number;
		elapsedSeconds: number;
		achievedGraphQLRps: number;
		passed: boolean;
	}[];
};

const isFiniteNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

export const parseCapacityLoadReport = (value: unknown): CapacityLoadReport => {
	if (!value || typeof value !== "object") throw new Error("Load report must be an object");
	const candidate = value as Record<string, unknown>;
	const model = candidate.model;
	const summary = candidate.summary;
	const window = candidate.window;
	const sustainability = candidate.sustainability;
	const stagesSeconds =
		model && typeof model === "object" ? (model as Record<string, unknown>).stagesSeconds : null;
	if (
		typeof candidate.runId !== "string" ||
		!/^[A-Za-z0-9_-]{8,32}$/.test(candidate.runId) ||
		typeof candidate.gatePassed !== "boolean" ||
		!model ||
		typeof model !== "object" ||
		(model as Record<string, unknown>).targetConcurrent !== 300 ||
		!stagesSeconds ||
		typeof stagesSeconds !== "object" ||
		!isFiniteNumber((stagesSeconds as Record<string, unknown>).sustainability) ||
		((stagesSeconds as Record<string, number>).sustainability as number) <= 0 ||
		!summary ||
		typeof summary !== "object" ||
		!Number.isSafeInteger((summary as Record<string, unknown>).sustainableRps) ||
		((summary as Record<string, unknown>).sustainableRps as number) < 0 ||
		!window ||
		typeof window !== "object" ||
		!Array.isArray((window as Record<string, unknown>).stageWindows) ||
		!Array.isArray(sustainability)
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
				isFiniteNumber(stage.finishedAt) &&
				Number.isSafeInteger(stage.serverGraphQLRequests) &&
				(stage.serverGraphQLRequests as number) > 0
			);
		})
	) {
		throw new Error("Load report contains an invalid stage window");
	}
	if (
		!sustainability.every((entry) => {
			if (!entry || typeof entry !== "object") return false;
			const phase = entry as Record<string, unknown>;
			return (
				typeof phase.phase === "string" &&
				phase.phase.length > 0 &&
				isFiniteNumber(phase.multiplier) &&
				(phase.multiplier as number) >= 1 &&
				isFiniteNumber(phase.durationSeconds) &&
				(phase.durationSeconds as number) > 0 &&
				isFiniteNumber(phase.elapsedSeconds) &&
				(phase.elapsedSeconds as number) > 0 &&
				isFiniteNumber(phase.achievedGraphQLRps) &&
				(phase.achievedGraphQLRps as number) >= 0 &&
				typeof phase.passed === "boolean"
			);
		})
	) {
		throw new Error("Load report contains invalid sustainability evidence");
	}
	return {
		runId: candidate.runId,
		gatePassed: candidate.gatePassed,
		model: {
			targetConcurrent: 300,
			stagesSeconds: {
				sustainability: (stagesSeconds as Record<string, number>).sustainability,
			},
		},
		summary: {
			sustainableRps: (summary as Record<string, number>).sustainableRps,
		},
		window: {
			stageWindows: stageWindows as CapacityLoadReport["window"]["stageWindows"],
		},
		sustainability: sustainability as CapacityLoadReport["sustainability"],
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
	if (report.model.stagesSeconds.sustainability < 5 * 60) {
		throw new Error("Capacity evidence requires five-minute sustainability probes");
	}
	const passedSustainability = report.sustainability.filter((phase) => phase.passed);
	const measuredSustainableRps = Math.floor(
		Math.max(0, ...passedSustainability.map((phase) => phase.achievedGraphQLRps))
	);
	if (measuredSustainableRps !== report.summary.sustainableRps) {
		throw new Error("Sustainable RPS does not match the passing probe evidence");
	}
	const reliedUponSustainability = passedSustainability.filter(
		(phase) => Math.floor(phase.achievedGraphQLRps) === report.summary.sustainableRps
	);
	if (
		reliedUponSustainability.length === 0 ||
		reliedUponSustainability.some(
			(phase) => phase.durationSeconds < 5 * 60 || phase.elapsedSeconds < phase.durationSeconds
		)
	) {
		throw new Error("Sustainable RPS must rely only on complete five-minute probes");
	}
	const window = report.window.stageWindows.find((candidate) => candidate.concurrent === 300);
	if (!window || window.finishedAt - window.startedAt < 15 * 60 * 1000) {
		throw new Error("Capacity evidence requires a complete fifteen-minute 300-concurrent stage");
	}
	const durationSeconds = (window.finishedAt - window.startedAt) / 1000;
	const requestIdPrefix = capacityRunRequestIdPrefix(report.runId);
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

	if (totalRequests !== window.serverGraphQLRequests) {
		throw new Error(
			`Capacity decision log coverage mismatch: expected ${window.serverGraphQLRequests}, matched ${totalRequests}`
		);
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
