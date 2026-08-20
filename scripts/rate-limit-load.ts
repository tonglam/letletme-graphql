import { createHash, createHmac } from "crypto";

type Workload =
	"interactive" | "home" | "fixtures" | "market" | "player-stats" | "gameweek" | "public-other";

type ActorKind = "mini" | "web_rsc" | "session" | "legacy" | "service";

type Actor = {
	id: string;
	kind: ActorKind;
	workload: Workload;
	path?: string;
	cookie?: string;
};

type RequestSample = {
	at: number;
	phase: string;
	actorId: string;
	kind: ActorKind;
	workload: Workload;
	transport: "graphql" | "page";
	status: number;
	durationMs: number;
	rateLimitScope: string | null;
	graphqlErrors: number;
	attacker: boolean;
};

type RuntimeSample = {
	at: number;
	healthOk: boolean;
	healthStatus: number;
	checks: Record<string, unknown> | null;
	poolWaiting: number | null;
	memoryBytes: number | null;
	cpuSeconds: number | null;
	globalDenied: number | null;
	globalWouldDenied: number | null;
	nonMiniDenied: number | null;
	wouldDenied: number | null;
	serverGraphQLRequests: number | null;
	serverNon429Errors: number | null;
	graphQLDurationBuckets: Record<string, number> | null;
};

const required = (name: string): string => {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`Missing required ${name}`);
	return value;
};

const positiveNumber = (name: string, fallback: number): number => {
	const raw = process.env[name];
	if (!raw) return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
	return value;
};

const requiredPositiveNumber = (name: string): number => {
	const value = Number(required(name));
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
	return value;
};

const booleanValue = (name: string): boolean => process.env[name] === "true";

const webOrigin = required("LOAD_WEB_ORIGIN").replace(/\/$/, "");
const graphQLOrigin = required("LOAD_GRAPHQL_ORIGIN").replace(/\/$/, "");
const backendSecret = required("BACKEND_PROXY_SECRET");
const serviceToken = required("GRAPHQL_SERVICE_TOKEN");
const metricsToken = required("LOAD_METRICS_TOKEN");
const memoryLimitBytes = requiredPositiveNumber("LOAD_MEMORY_LIMIT_BYTES");
const cpuCores = requiredPositiveNumber("LOAD_CPU_CORES");
const stageSeconds = positiveNumber("LOAD_STAGE_SECONDS", 300);
const finalStageSeconds = positiveNumber("LOAD_FINAL_STAGE_SECONDS", 900);
const burstSeconds = positiveNumber("LOAD_BURST_SECONDS", 10);
const maliciousSeconds = positiveNumber("LOAD_MALICIOUS_SECONDS", 60);
const thinkMs = positiveNumber("LOAD_THINK_MS", 10_000);
const monitorMs = positiveNumber("LOAD_MONITOR_MS", 5_000);
const sustainabilitySeconds = positiveNumber("LOAD_SUSTAINABILITY_SECONDS", 300);
const sustainabilityMultipliers = (process.env.LOAD_SUSTAINABILITY_MULTIPLIERS ?? "1.75,2")
	.split(",")
	.map((value) => Number(value.trim()))
	.filter(Number.isFinite);
const allowHttp = booleanValue("LOAD_ALLOW_HTTP");
const skipSessionValidation = booleanValue("LOAD_SKIP_SESSION_VALIDATION");
const runId = process.env.LOAD_RUN_ID?.trim() || `capacity-${Date.now().toString(36)}`;

if (!/^[A-Za-z0-9._:-]{8,48}$/.test(runId)) {
	throw new Error("LOAD_RUN_ID must contain 8-48 safe identifier characters");
}
if (
	sustainabilityMultipliers.length === 0 ||
	sustainabilityMultipliers.some(
		(value, index) => value <= 1 || (index > 0 && value <= sustainabilityMultipliers[index - 1]!)
	)
) {
	throw new Error("LOAD_SUSTAINABILITY_MULTIPLIERS must be strictly increasing numbers above one");
}

if (!allowHttp && (!webOrigin.startsWith("https://") || !graphQLOrigin.startsWith("https://"))) {
	throw new Error("Production capacity origins must use HTTPS");
}

const outputIndex = Bun.argv.indexOf("--output");
const outputPath = outputIndex >= 0 ? Bun.argv[outputIndex + 1] : undefined;
if (outputIndex >= 0 && !outputPath) throw new Error("--output requires a path");

const isStringArray = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((item) => typeof item === "string");

const sessionCookies = ((): string[] => {
	const raw = process.env.LOAD_SESSION_COOKIES_JSON?.trim() || "[]";
	const parsed = JSON.parse(raw) as unknown;
	if (!isStringArray(parsed)) {
		throw new Error("LOAD_SESSION_COOKIES_JSON must be a JSON string array");
	}
	const bounded = parsed.map((value) => value.trim()).filter(Boolean);
	if (!skipSessionValidation && (bounded.length < 45 || new Set(bounded).size < 45)) {
		throw new Error("Capacity mode requires 45 distinct signed-in session cookies");
	}
	return bounded;
})();

const sleep = (milliseconds: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, milliseconds));

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const signedLegacyHeaders = (actorId: string): Record<string, string> => {
	const now = Math.floor(Date.now() / 1000);
	const payload = JSON.stringify({
		aud: "letletme-graphql",
		sub: sha256(`load:${runId}:${actorId}`),
		iat: now,
		exp: now + 60,
	});
	return {
		"X-Ingress-Context": Buffer.from(payload).toString("base64url"),
		"X-Ingress-Context-Sig": createHmac("sha256", backendSecret)
			.update(payload)
			.digest("base64url"),
	};
};

const queryForWorkload = (
	workload: Workload
): { query: string; variables: Record<string, unknown>; operationName: string } => {
	switch (workload) {
		case "fixtures":
			return {
				operationName: "CapacityFixtureWindow",
				query: `query CapacityFixtureWindow($eventId: Int!) {
					eventFixtures(eventId: $eventId) {
						id kickoffTime finished
						homeTeam { id shortName }
						awayTeam { id shortName }
					}
				}`,
				variables: { eventId: 1 },
			};
		case "market":
			return {
				operationName: "CapacityMarketPulse",
				query: `query CapacityMarketPulse($days: Int!) {
					marketPulse(days: $days) {
						coverage { requestedDays observedDays complete stale }
						mostSelected { playerId webName selectedByPercent }
						transferMovers { netTransfers player { playerId webName } }
					}
				}`,
				variables: { days: 7 },
			};
		case "player-stats":
			return {
				operationName: "CapacityPlayerStats",
				query: `query CapacityPlayerStats {
					currentEventInfo { season currentEvent nextEvent nextUtcDeadline }
				}`,
				variables: {},
			};
		case "gameweek":
			return {
				operationName: "CapacityGameweek",
				query: "query CapacityGameweek { miniProgramNotice }",
				variables: {},
			};
		case "interactive":
			return {
				operationName: "CapacityInteractive",
				query: `query CapacityInteractive {
					currentEventInfo { season currentEvent nextEvent nextUtcDeadline }
				}`,
				variables: {},
			};
		case "home":
		case "public-other":
			return {
				operationName: "CapacityHome",
				query: `query CapacityHome {
					currentEventInfo { season currentEvent nextEvent nextUtcDeadline }
				}`,
				variables: {},
			};
	}
};

const buildActors = (): Actor[] => {
	const miniWorkloads: Workload[] = ["home", "fixtures", "market", "player-stats", "gameweek"];
	const miniActors: Actor[] = Array.from({ length: 180 }, (_, index) => ({
		id: `mini-${index + 1}`,
		kind: "mini" as const,
		workload: miniWorkloads[index % miniWorkloads.length]!,
	}));
	const rscActors: Actor[] = Array.from({ length: 60 }, (_, index) => {
		const groupIndex = index % 10;
		const workload: Workload =
			groupIndex < 5 ? "player-stats" : groupIndex < 8 ? "fixtures" : "market";
		const path =
			workload === "player-stats"
				? "/en/explore/player-stats"
				: workload === "fixtures"
					? "/en/explore/fixtures"
					: "/en/explore/market";
		return {
			id: `rsc-${workload}-${index + 1}`,
			kind: "web_rsc" as const,
			workload,
			path,
		};
	});
	const sessionActors: Actor[] = Array.from({ length: 45 }, (_, index) => ({
		id: `session-${index + 1}`,
		kind: "session" as const,
		workload: "interactive" as const,
		path: index % 2 === 0 ? "/en/my-fpl/team" : "/en/live/points",
		cookie: sessionCookies[index] ?? sessionCookies[index % Math.max(1, sessionCookies.length)],
	}));
	const compatibilityActors: Actor[] = Array.from({ length: 15 }, (_, index) => {
		const kind: "legacy" | "service" = index % 2 === 0 ? "legacy" : "service";
		return {
			id: `${kind}-${index + 1}`,
			kind,
			workload: "public-other" as const,
		};
	});
	return [...miniActors, ...rscActors, ...sessionActors, ...compatibilityActors];
};

const actors = buildActors();
if (actors.length !== 300) throw new Error("Capacity actor model must contain exactly 300 actors");

const samples: RequestSample[] = [];
const runtimeSamples: RuntimeSample[] = [];

const graphQLRequest = async (
	actor: Actor,
	attacker: boolean,
	phase: string
): Promise<RequestSample> => {
	const target = actor.kind === "mini" ? `${webOrigin}/api/graphql` : `${graphQLOrigin}/graphql`;
	const request = queryForWorkload(actor.workload);
	const headers: Record<string, string> = {
		"content-type": "application/json",
		accept: "application/json",
		"user-agent": `LetLetMe-Capacity/${runId}`,
		"X-Request-Id": `${runId}-${actor.id}-${Date.now().toString(36)}`.slice(0, 96),
	};
	if (actor.kind === "mini") {
		headers["X-Letletme-Client"] = "wechat-miniprogram";
		headers["X-Letletme-Device-Id"] = `load-${runId}-${actor.id}`.slice(0, 128);
	} else if (actor.kind === "legacy") {
		Object.assign(headers, signedLegacyHeaders(actor.id));
	} else if (actor.kind === "service") {
		headers["X-GraphQL-Service-Token"] = serviceToken;
	}
	const startedAt = performance.now();
	let status: number;
	let rateLimitScope: string | null;
	let graphqlErrors = 0;
	try {
		const response = await fetch(target, {
			method: "POST",
			headers,
			body: JSON.stringify(request),
			signal: AbortSignal.timeout(10_000),
		});
		status = response.status;
		rateLimitScope = response.headers.get("x-ratelimit-scope");
		const body = (await response.json().catch(() => null)) as {
			errors?: readonly unknown[];
		} | null;
		graphqlErrors = body?.errors?.length ?? 0;
	} catch {
		status = 0;
		rateLimitScope = "transport";
	}
	return {
		at: Date.now(),
		phase,
		actorId: actor.id,
		kind: actor.kind,
		workload: actor.workload,
		transport: "graphql",
		status,
		durationMs: performance.now() - startedAt,
		rateLimitScope,
		graphqlErrors,
		attacker,
	};
};

const pageRequest = async (actor: Actor, phase: string): Promise<RequestSample> => {
	const separator = actor.path?.includes("?") ? "&" : "?";
	const target = `${webOrigin}${actor.path}${separator}capacityRun=${encodeURIComponent(runId)}`;
	const headers: Record<string, string> = {
		accept: "text/html",
		"user-agent": `LetLetMe-Capacity/${runId}`,
	};
	if (actor.cookie) headers.cookie = actor.cookie;
	const startedAt = performance.now();
	let status: number;
	try {
		const response = await fetch(target, {
			headers,
			redirect: "manual",
			signal: AbortSignal.timeout(15_000),
		});
		status = response.status;
		await response.body?.cancel();
	} catch {
		status = -1;
	}
	return {
		at: Date.now(),
		phase,
		actorId: actor.id,
		kind: actor.kind,
		workload: actor.workload,
		transport: "page",
		status,
		durationMs: performance.now() - startedAt,
		rateLimitScope: null,
		graphqlErrors: 0,
		attacker: false,
	};
};

const executeActor = (actor: Actor, phase: string, attacker = false): Promise<RequestSample> =>
	actor.kind === "web_rsc" || actor.kind === "session"
		? pageRequest(actor, phase)
		: graphQLRequest(actor, attacker, phase);

const actorLoop = async (
	actor: Actor,
	deadline: number,
	delayMs: number,
	phase: string,
	attacker = false
): Promise<void> => {
	while (Date.now() < deadline) {
		samples.push(await executeActor(actor, phase, attacker));
		if (delayMs > 0) await sleep(delayMs);
	}
};

const runStage = async (concurrent: number, durationSeconds: number): Promise<void> => {
	const miniCount = Math.round(concurrent * 0.6);
	const rscCount = Math.round(concurrent * 0.2);
	const sessionCount = Math.round(concurrent * 0.15);
	const compatibilityCount = concurrent - miniCount - rscCount - sessionCount;
	const selected = [
		...actors.filter((actor) => actor.kind === "mini").slice(0, miniCount),
		...actors.filter((actor) => actor.kind === "web_rsc").slice(0, rscCount),
		...actors.filter((actor) => actor.kind === "session").slice(0, sessionCount),
		...actors
			.filter((actor) => actor.kind === "legacy" || actor.kind === "service")
			.slice(0, compatibilityCount),
	];
	const deadline = Date.now() + durationSeconds * 1000;
	await Promise.all(
		selected.map((actor) => actorLoop(actor, deadline, thinkMs, `stage-${concurrent}`))
	);
};

const metricValue = (body: string, name: string, labels?: string): number | null => {
	const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const escapedLabels = labels?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(
		`^${escapedName}${escapedLabels ? `\\{${escapedLabels}\\}` : "(?:\\{[^}]*\\})?"}\\s+([^\\s]+)$`,
		"m"
	);
	const match = pattern.exec(body);
	const value = Number(match?.[1]);
	return Number.isFinite(value) ? value : null;
};

const metricSum = (
	body: string,
	name: string,
	acceptLabels: (labels: string) => boolean
): number | null => {
	if (!body) return null;
	let matched = false;
	let total = 0;
	for (const line of body.split("\n")) {
		if (!line.startsWith(`${name}{`)) continue;
		const closing = line.indexOf("}");
		if (closing < 0) continue;
		const labels = line.slice(name.length + 1, closing);
		if (!acceptLabels(labels)) continue;
		const value = Number(line.slice(closing + 1).trim());
		if (!Number.isFinite(value)) continue;
		matched = true;
		total += value;
	}
	return matched ? total : 0;
};

const collectGraphQLDurationBuckets = (body: string): Record<string, number> | null => {
	if (!body) return null;
	const buckets: Record<string, number> = {};
	for (const line of body.split("\n")) {
		if (!line.startsWith("http_request_duration_seconds_bucket{")) continue;
		const closing = line.indexOf("}");
		if (closing < 0) continue;
		const labelText = line.slice(line.indexOf("{") + 1, closing);
		const labels = Object.fromEntries(
			[...labelText.matchAll(/([a-z_]+)="([^"]*)"/g)].map((match) => [match[1], match[2]])
		);
		if (labels.method !== "POST" || labels.route !== "/graphql" || !labels.le) continue;
		const value = Number(line.slice(closing + 1).trim());
		if (!Number.isFinite(value)) continue;
		buckets[labels.le] = (buckets[labels.le] ?? 0) + value;
	}
	return Object.keys(buckets).length > 0 ? buckets : null;
};

const percentile = (values: readonly number[], quantile: number): number => {
	if (values.length === 0) return 0;
	const ordered = [...values].sort((left, right) => left - right);
	return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * quantile) - 1)] ?? 0;
};

type CounterField =
	| "globalDenied"
	| "globalWouldDenied"
	| "nonMiniDenied"
	| "wouldDenied"
	| "serverGraphQLRequests"
	| "serverNon429Errors";
const counterDelta = (
	field: CounterField,
	start: RuntimeSample | undefined,
	end: RuntimeSample | undefined
): number => {
	const startValue = start?.[field];
	const endValue = end?.[field];
	if (
		startValue === null ||
		startValue === undefined ||
		endValue === null ||
		endValue === undefined
	) {
		return Number.POSITIVE_INFINITY;
	}
	return Math.max(0, endValue - startValue);
};

const histogramQuantileDeltaMs = (
	start: RuntimeSample | undefined,
	end: RuntimeSample | undefined,
	quantile: number
): number => {
	const startBuckets = start?.graphQLDurationBuckets;
	const endBuckets = end?.graphQLDurationBuckets;
	if (!startBuckets || !endBuckets) return Number.POSITIVE_INFINITY;
	const total = Math.max(0, (endBuckets["+Inf"] ?? 0) - (startBuckets["+Inf"] ?? 0));
	if (total === 0) return Number.POSITIVE_INFINITY;
	const threshold = total * quantile;
	const bounds = Object.keys(endBuckets)
		.filter((bound) => bound !== "+Inf")
		.map(Number)
		.filter(Number.isFinite)
		.sort((left, right) => left - right);
	for (const bound of bounds) {
		const key = String(bound);
		const count = Math.max(0, (endBuckets[key] ?? 0) - (startBuckets[key] ?? 0));
		if (count >= threshold) return bound * 1000;
	}
	return Number.POSITIVE_INFINITY;
};

const hasSustainedBreach = (
	observations: readonly { at: number; value: number }[],
	threshold: number,
	durationMs: number
): boolean => {
	let breachStartedAt: number | null = null;
	for (const observation of observations) {
		if (observation.value > threshold) {
			breachStartedAt ??= observation.at;
			if (observation.at - breachStartedAt >= durationMs) return true;
		} else {
			breachStartedAt = null;
		}
	}
	return false;
};

const dependencyChecksReady = (checks: Record<string, unknown> | null): boolean =>
	Boolean(
		checks &&
		["redis", "rateLimitRedis", "postgres", "season"].every((name) => checks[name] === "ok")
	);

type SustainablePhaseResult = {
	phase: string;
	multiplier: number;
	durationSeconds: number;
	achievedGraphQLRps: number;
	passed: boolean;
	reasons: string[];
};

const evaluateSustainablePhase = ({
	phase,
	multiplier,
	durationSeconds,
	runtimeStartIndex,
	runtimeEndIndex,
}: {
	phase: string;
	multiplier: number;
	durationSeconds: number;
	runtimeStartIndex: number;
	runtimeEndIndex: number;
}): SustainablePhaseResult => {
	const phaseSamples = samples.filter((sample) => sample.phase === phase);
	const directGraphQL = phaseSamples.filter((sample) => sample.transport === "graphql");
	const directErrors = directGraphQL.filter(
		(sample) =>
			sample.status <= 0 ||
			(sample.status >= 400 && sample.status !== 429) ||
			sample.graphqlErrors > 0
	);
	const directErrorRate =
		directGraphQL.length === 0 ? 1 : directErrors.length / directGraphQL.length;
	const directP95 = percentile(
		directGraphQL.map((sample) => sample.durationMs),
		0.95
	);
	const directP99 = percentile(
		directGraphQL.map((sample) => sample.durationMs),
		0.99
	);
	const runtimeStart = runtimeSamples[runtimeStartIndex];
	const runtimeEnd = runtimeSamples[runtimeEndIndex];
	const serverRequests = counterDelta("serverGraphQLRequests", runtimeStart, runtimeEnd);
	const serverErrors = counterDelta("serverNon429Errors", runtimeStart, runtimeEnd);
	const serverErrorRate =
		serverRequests === 0 || !Number.isFinite(serverRequests) ? 1 : serverErrors / serverRequests;
	const serverP95 = histogramQuantileDeltaMs(runtimeStart, runtimeEnd, 0.95);
	const serverP99 = histogramQuantileDeltaMs(runtimeStart, runtimeEnd, 0.99);
	const runtimeWindow = runtimeSamples.slice(runtimeStartIndex, runtimeEndIndex + 1);
	const pageErrors = phaseSamples.filter(
		(sample) => sample.transport === "page" && (sample.status < 200 || sample.status >= 300)
	);
	const cpuWindow = runtimeWindow.slice(1).map((sample, index) => {
		const previous = runtimeWindow[index]!;
		const elapsedSeconds = (sample.at - previous.at) / 1000;
		return {
			at: sample.at,
			value:
				sample.cpuSeconds === null || previous.cpuSeconds === null || elapsedSeconds <= 0
					? Number.POSITIVE_INFINITY
					: ((sample.cpuSeconds - previous.cpuSeconds) / elapsedSeconds / cpuCores) * 100,
		};
	});
	const reasons: string[] = [];
	if (directGraphQL.some((sample) => sample.status === 429)) reasons.push("direct 429");
	if (counterDelta("nonMiniDenied", runtimeStart, runtimeEnd) > 0) reasons.push("non-Mini denied");
	if (counterDelta("wouldDenied", runtimeStart, runtimeEnd) > 0) reasons.push("v3 would deny");
	if (pageErrors.length > 0) reasons.push("page transport error");
	if (Math.max(directErrorRate, serverErrorRate) >= 0.001) reasons.push("non-429 errors");
	if (directP95 >= 800 || serverP95 >= 800) reasons.push("p95 latency");
	if (directP99 >= 2_000 || serverP99 >= 2_000) reasons.push("p99 latency");
	if (runtimeWindow.some((sample) => !sample.healthOk)) reasons.push("health");
	if (runtimeWindow.some((sample) => !dependencyChecksReady(sample.checks))) {
		reasons.push("dependency health");
	}
	if (runtimeWindow.some((sample) => sample.poolWaiting !== 0)) reasons.push("pool waiting");
	if (
		runtimeWindow.some(
			(sample) => sample.memoryBytes === null || (sample.memoryBytes / memoryLimitBytes) * 100 > 85
		)
	) {
		reasons.push("memory");
	}
	if (hasSustainedBreach(cpuWindow, 80, 5 * 60 * 1000)) reasons.push("sustained CPU");
	return {
		phase,
		multiplier,
		durationSeconds,
		achievedGraphQLRps: serverRequests / durationSeconds,
		passed: reasons.length === 0,
		reasons,
	};
};

const collectRuntimeSample = async (): Promise<void> => {
	let healthStatus: number;
	let healthOk = false;
	let checks: Record<string, unknown> | null = null;
	let metricsBody = "";
	try {
		const [healthResponse, metricsResponse] = await Promise.all([
			fetch(`${graphQLOrigin}/health`, { signal: AbortSignal.timeout(5_000) }),
			fetch(`${graphQLOrigin}/metrics`, {
				headers: { "X-Metrics-Token": metricsToken },
				signal: AbortSignal.timeout(5_000),
			}),
		]);
		healthStatus = healthResponse.status;
		const healthBody = (await healthResponse.json().catch(() => null)) as {
			status?: string;
			checks?: Record<string, unknown>;
		} | null;
		healthOk = healthResponse.ok && healthBody?.status === "ok";
		checks = healthBody?.checks ?? null;
		if (metricsResponse.ok) metricsBody = await metricsResponse.text();
	} catch {
		healthStatus = -1;
	}
	runtimeSamples.push({
		at: Date.now(),
		healthOk,
		healthStatus,
		checks,
		poolWaiting: metricValue(metricsBody, "postgres_pool_clients", 'state="waiting"'),
		memoryBytes: metricValue(metricsBody, "process_resident_memory_bytes"),
		cpuSeconds: ((): number | null => {
			const user = metricValue(metricsBody, "process_cpu_user_seconds_total");
			const system = metricValue(metricsBody, "process_cpu_system_seconds_total");
			return user === null || system === null ? null : user + system;
		})(),
		globalDenied: metricSum(
			metricsBody,
			"graphql_rate_limit_v3_decisions_total",
			(labels) => labels.includes('scope="global"') && labels.includes('outcome="denied"')
		),
		globalWouldDenied: metricSum(
			metricsBody,
			"graphql_rate_limit_v3_decisions_total",
			(labels) => labels.includes('scope="global"') && labels.includes('outcome="would_deny"')
		),
		nonMiniDenied: metricSum(
			metricsBody,
			"graphql_rate_limit_v3_decisions_total",
			(labels) => !labels.includes('traffic_class="mini"') && labels.includes('outcome="denied"')
		),
		wouldDenied: metricSum(metricsBody, "graphql_rate_limit_v3_decisions_total", (labels) =>
			labels.includes('outcome="would_deny"')
		),
		serverGraphQLRequests: metricSum(metricsBody, "graphql_request_outcomes_total", () => true),
		serverNon429Errors: metricSum(
			metricsBody,
			"graphql_request_outcomes_total",
			(labels) =>
				labels.includes('result="graphql_error"') ||
				labels.includes('result="client_error"') ||
				labels.includes('result="server_error"')
		),
		graphQLDurationBuckets: collectGraphQLDurationBuckets(metricsBody),
	});
};

let monitorQueue: Promise<void> = Promise.resolve();
const monitorOnce = (): Promise<void> => {
	const pending = monitorQueue.then(collectRuntimeSample, collectRuntimeSample);
	monitorQueue = pending.catch(() => undefined);
	return pending;
};

await monitorOnce();
let monitoring = true;
const monitor = (async (): Promise<void> => {
	while (monitoring) {
		await sleep(monitorMs);
		if (monitoring) await monitorOnce();
	}
})();

const startedAt = Date.now();
const stageWindows: Array<{
	concurrent: number;
	startedAt: number;
	finishedAt: number;
	runtimeStartIndex: number;
	runtimeEndIndex: number;
}> = [];
for (const [concurrent, duration] of [
	[50, stageSeconds],
	[100, stageSeconds],
	[200, stageSeconds],
	[300, finalStageSeconds],
] as const) {
	await monitorOnce();
	const runtimeStartIndex = runtimeSamples.length - 1;
	const stageStartedAt = Date.now();
	await runStage(concurrent, duration);
	const stageFinishedAt = Date.now();
	await monitorOnce();
	stageWindows.push({
		concurrent,
		startedAt: stageStartedAt,
		finishedAt: stageFinishedAt,
		runtimeStartIndex,
		runtimeEndIndex: runtimeSamples.length - 1,
	});
}

// Ten-second cold burst: every target actor fires at twice the ordinary pace.
await Promise.all(
	actors.map((actor) => actorLoop(actor, Date.now() + burstSeconds * 1000, thinkMs / 2, "burst"))
);

await monitorOnce();
const capacityRuntimeSampleIndex = runtimeSamples.length - 1;

// One abusive Mini device competes with 99 normal devices on the same source NAT.
const attacker: Actor = { id: "mini-attacker", kind: "mini", workload: "market" };
const maliciousDeadline = Date.now() + maliciousSeconds * 1000;
await Promise.all([
	actorLoop(attacker, maliciousDeadline, 0, "malicious", true),
	...actors.slice(0, 99).map((actor) => actorLoop(actor, maliciousDeadline, thinkMs, "malicious")),
]);

await monitorOnce();
const isolationRuntimeSampleIndex = runtimeSamples.length - 1;
const isolationFinishedAt = Date.now();

const targetStage = stageWindows.find((stage) => stage.concurrent === 300);
if (!targetStage) throw new Error("Missing 300-concurrent capacity stage");
const sustainability: SustainablePhaseResult[] = [
	evaluateSustainablePhase({
		phase: "stage-300",
		multiplier: 1,
		durationSeconds: finalStageSeconds,
		runtimeStartIndex: targetStage.runtimeStartIndex,
		runtimeEndIndex: targetStage.runtimeEndIndex,
	}),
];
for (const multiplier of sustainabilityMultipliers) {
	await monitorOnce();
	const runtimeStartIndex = runtimeSamples.length - 1;
	const phase = `sustainable-${multiplier}x`;
	const deadline = Date.now() + sustainabilitySeconds * 1000;
	await Promise.all(actors.map((actor) => actorLoop(actor, deadline, thinkMs / multiplier, phase)));
	await monitorOnce();
	const result = evaluateSustainablePhase({
		phase,
		multiplier,
		durationSeconds: sustainabilitySeconds,
		runtimeStartIndex,
		runtimeEndIndex: runtimeSamples.length - 1,
	});
	sustainability.push(result);
	if (!result.passed) break;
}

monitoring = false;
await monitor;
await monitorOnce();
const finishedAt = Date.now();

const capacitySamples = samples.filter(
	(sample) => sample.phase.startsWith("stage-") || sample.phase === "burst"
);
const capacityGraphQL = capacitySamples.filter((sample) => sample.transport === "graphql");
const capacityPageErrors = capacitySamples.filter(
	(sample) => sample.transport === "page" && (sample.status < 200 || sample.status >= 300)
);
const attackerSamples = samples.filter((sample) => sample.attacker);
const natPeerSamples = samples.filter((sample) => sample.phase === "malicious" && !sample.attacker);
const natPeerGraphQL = natPeerSamples.filter((sample) => sample.transport === "graphql");
const normal429 = [...capacityGraphQL, ...natPeerGraphQL].filter((sample) => sample.status === 429);
const global429 = normal429.filter((sample) => sample.rateLimitScope === "global");
const baselineRuntime = runtimeSamples[0];
const capacityRuntime = runtimeSamples[capacityRuntimeSampleIndex];
const isolationRuntime = runtimeSamples[isolationRuntimeSampleIndex];
const baseRuntimeSamples = runtimeSamples.slice(0, isolationRuntimeSampleIndex + 1);
const actualGlobalDenied = counterDelta("globalDenied", baselineRuntime, isolationRuntime);
const globalWouldDenied = counterDelta("globalWouldDenied", baselineRuntime, isolationRuntime);
const nonMiniDenied = counterDelta("nonMiniDenied", baselineRuntime, isolationRuntime);
const capacityWouldDenied = counterDelta("wouldDenied", baselineRuntime, capacityRuntime);
const attackerWouldDenied = counterDelta("wouldDenied", capacityRuntime, isolationRuntime);
const serverGraphQLRequests = counterDelta(
	"serverGraphQLRequests",
	baselineRuntime,
	capacityRuntime
);
const serverNon429Errors = counterDelta("serverNon429Errors", baselineRuntime, capacityRuntime);
const non429Errors = capacityGraphQL.filter(
	(sample) =>
		sample.status <= 0 ||
		(sample.status >= 400 && sample.status !== 429) ||
		sample.graphqlErrors > 0
);
const directNon429ErrorRate =
	capacityGraphQL.length === 0 ? 1 : non429Errors.length / capacityGraphQL.length;
const serverNon429ErrorRate =
	serverGraphQLRequests === 0 || !Number.isFinite(serverGraphQLRequests)
		? 1
		: serverNon429Errors / serverGraphQLRequests;
const non429ErrorRate = Math.max(directNon429ErrorRate, serverNon429ErrorRate);
const graphQLDurations = capacityGraphQL.map((sample) => sample.durationMs);
const clientGraphQLP95Ms = percentile(graphQLDurations, 0.95);
const clientGraphQLP99Ms = percentile(graphQLDurations, 0.99);
const serverGraphQLP95UpperBoundMs = histogramQuantileDeltaMs(
	baselineRuntime,
	capacityRuntime,
	0.95
);
const serverGraphQLP99UpperBoundMs = histogramQuantileDeltaMs(
	baselineRuntime,
	capacityRuntime,
	0.99
);
const maxPoolWaiting = Math.max(
	0,
	...baseRuntimeSamples.map((sample) => sample.poolWaiting ?? Number.POSITIVE_INFINITY)
);
const maxMemoryPercent = Math.max(
	0,
	...baseRuntimeSamples.map((sample) =>
		sample.memoryBytes === null
			? Number.POSITIVE_INFINITY
			: (sample.memoryBytes / memoryLimitBytes) * 100
	)
);
const cpuObservations = baseRuntimeSamples.slice(1).map((sample, index) => {
	const previous = baseRuntimeSamples[index]!;
	if (sample.cpuSeconds === null || previous.cpuSeconds === null) {
		return { at: sample.at, value: Number.POSITIVE_INFINITY };
	}
	const elapsedSeconds = (sample.at - previous.at) / 1000;
	return {
		at: sample.at,
		value:
			elapsedSeconds <= 0
				? Number.POSITIVE_INFINITY
				: ((sample.cpuSeconds - previous.cpuSeconds) / elapsedSeconds / cpuCores) * 100,
	};
});
const maxCpuPercent = Math.max(0, ...cpuObservations.map(({ value }) => value));
const cpuSustainedBreach = hasSustainedBreach(cpuObservations, 80, 5 * 60 * 1000);
const runtimeMetricsComplete = baseRuntimeSamples.every(
	(sample) =>
		sample.poolWaiting !== null &&
		sample.memoryBytes !== null &&
		sample.cpuSeconds !== null &&
		sample.serverGraphQLRequests !== null &&
		sample.serverNon429Errors !== null &&
		sample.graphQLDurationBuckets !== null
);
const healthFailures = baseRuntimeSamples.filter((sample) => !sample.healthOk).length;
const dependencyHealthFailures = baseRuntimeSamples.filter(
	(sample) => !dependencyChecksReady(sample.checks)
).length;
const attacker429 = attackerSamples.filter((sample) => sample.status === 429).length;
const natPeer429 = natPeerGraphQL.filter((sample) => sample.status === 429).length;
const natPeerErrors = natPeerSamples.filter(
	(sample) => sample.status < 200 || sample.status >= 300 || sample.graphqlErrors > 0
).length;
const elapsedSeconds = Math.max(1, (isolationFinishedAt - startedAt) / 1000);
const capacityElapsedSeconds = Math.max(
	1,
	((capacityRuntime?.at ?? isolationFinishedAt) - startedAt) / 1000
);
const sustainableRps = Math.floor(
	Math.max(
		0,
		...sustainability.filter((phase) => phase.passed).map((phase) => phase.achievedGraphQLRps)
	)
);
const targetGraphQLRps = sustainability[0]?.achievedGraphQLRps ?? Number.POSITIVE_INFINITY;
const sustainableRpsHeadroomProven =
	(sustainability[0]?.passed ?? false) &&
	sustainableRps >= 2 &&
	targetGraphQLRps <= Math.floor(0.6 * sustainableRps);

const workloadCounts = Object.fromEntries(
	(
		[
			"interactive",
			"home",
			"fixtures",
			"market",
			"player-stats",
			"gameweek",
			"public-other",
		] as const
	).map((workload) => [
		workload,
		capacitySamples.filter((sample) => sample.workload === workload).length,
	])
);

const gates = {
	normal429Zero: normal429.length === 0 && nonMiniDenied === 0,
	global429Zero: global429.length === 0 && actualGlobalDenied === 0 && globalWouldDenied === 0,
	pageRequestsSuccessful: capacityPageErrors.length === 0,
	v3TargetWouldDenyZero: capacityWouldDenied === 0,
	non429ErrorRateBelowPointOnePercent: non429ErrorRate < 0.001,
	graphQLP95Below800Ms: clientGraphQLP95Ms < 800 && serverGraphQLP95UpperBoundMs < 800,
	graphQLP99Below2s: clientGraphQLP99Ms < 2_000 && serverGraphQLP99UpperBoundMs < 2_000,
	postgresPoolWaitingZero: maxPoolWaiting === 0,
	healthAlwaysReady: healthFailures === 0,
	dependencyHealthAlwaysReady: dependencyHealthFailures === 0,
	runtimeMetricsComplete,
	cpuBelow80PercentForFiveMinutes: !cpuSustainedBreach,
	memoryBelow85Percent: maxMemoryPercent <= 85,
	attackerWasIsolated: attacker429 > 0 || attackerWouldDenied > 0,
	natPeersUnaffected: natPeer429 === 0 && natPeerErrors === 0,
	sustainableRpsHeadroomProven,
};

const report = {
	runId,
	generatedAt: new Date().toISOString(),
	model: {
		targetConcurrent: 300,
		mini: 180,
		sharedNatMini: 100,
		webRsc: { total: 60, playerStats: 30, fixtures: 18, market: 12 },
		session: 45,
		legacy: 8,
		service: 7,
		stagesSeconds: {
			50: stageSeconds,
			100: stageSeconds,
			200: stageSeconds,
			300: finalStageSeconds,
			burst: burstSeconds,
			malicious: maliciousSeconds,
			sustainability: sustainabilitySeconds,
		},
		sustainabilityMultipliers,
	},
	window: {
		startedAt,
		capacityFinishedAt: runtimeSamples[capacityRuntimeSampleIndex]?.at ?? finishedAt,
		isolationFinishedAt,
		finishedAt,
		stageWindows: stageWindows.map(({ concurrent, startedAt, finishedAt }) => ({
			concurrent,
			startedAt,
			finishedAt,
		})),
	},
	summary: {
		elapsedSeconds,
		totalRequests: samples.length,
		normalGraphQLRequests: capacityGraphQL.length,
		pageErrors: capacityPageErrors.length,
		totalRequestPerSecond: capacitySamples.length / capacityElapsedSeconds,
		targetGraphQLRps,
		sustainableRps,
		normal429: normal429.length,
		global429: global429.length,
		actualGlobalDenied,
		globalWouldDenied,
		nonMiniDenied,
		capacityWouldDenied,
		attackerWouldDenied,
		non429Errors: non429Errors.length,
		directNon429ErrorRate,
		serverGraphQLRequests,
		serverNon429Errors,
		serverNon429ErrorRate,
		non429ErrorRate,
		clientGraphQLP95Ms,
		clientGraphQLP99Ms,
		serverGraphQLP95UpperBoundMs,
		serverGraphQLP99UpperBoundMs,
		maxPoolWaiting,
		maxCpuPercent,
		cpuSustainedBreach,
		maxMemoryPercent,
		healthFailures,
		dependencyHealthFailures,
		attackerRequests: attackerSamples.length,
		attacker429,
		natPeerRequests: natPeerSamples.length,
		natPeer429,
		natPeerErrors,
		workloadCounts,
	},
	sustainability,
	gates,
	gatePassed: Object.values(gates).every(Boolean),
	runtimeSamples,
};

const rendered = `${JSON.stringify(report, null, "\t")}\n`;
if (outputPath) await Bun.write(outputPath, rendered);
else process.stdout.write(rendered);
if (!report.gatePassed) process.exitCode = 1;
