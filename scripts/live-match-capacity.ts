import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
	connect as http2Connect,
	constants as http2Constants,
	type ClientHttp2Session,
	type Settings,
} from "node:http2";
import { brotliDecompress, gunzip, inflate } from "node:zlib";
import { writeFile } from "node:fs/promises";

type ReadMode = "HEAD" | "DESK" | "FULL";
type Transport = "cold" | "warm";

type ResponseSample = {
	stage: number;
	status: number;
	ttfbMs: number;
	bodyDownloadMs: number;
	durationMs: number;
	encodedBytes: number;
	decodedBytes: number;
	semanticOk: boolean;
	errorCode: string | null;
	globalRateLimit: boolean;
	rateLimitScope: string | null;
};

type MetricObservation = {
	at: string;
	poolWaiting: number | null;
	poolWaitEvents: number | null;
	globalDenied: number | null;
};

type MetricSummary = {
	count: number;
	p50: number | null;
	p95: number | null;
	p99: number | null;
	max: number | null;
};

const required = (name: string): string => {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`Missing required ${name}`);
	return value;
};

const positiveInteger = (name: string, fallback: number): number => {
	const raw = process.env[name]?.trim();
	if (!raw) return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be positive`);
	return value;
};

const nonNegativeInteger = (name: string, fallback: number): number => {
	const raw = process.env[name]?.trim();
	if (!raw) return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be non-negative`);
	return value;
};

const option = (name: string): string | undefined => {
	const index = Bun.argv.indexOf(name);
	return index >= 0 ? Bun.argv[index + 1]?.trim() : undefined;
};

const parseMode = (value: string | undefined): ReadMode => {
	const mode = (value ?? process.env.LIVE_MATCH_LOAD_MODE ?? "FULL").toUpperCase();
	if (mode !== "HEAD" && mode !== "DESK" && mode !== "FULL") {
		throw new Error("LIVE_MATCH_LOAD_MODE must be HEAD, DESK, or FULL");
	}
	return mode;
};

const parseTransport = (value: string | undefined): Transport => {
	const transport = (value ?? process.env.LIVE_MATCH_LOAD_TRANSPORT ?? "warm").toLowerCase();
	if (transport !== "cold" && transport !== "warm") {
		throw new Error("LIVE_MATCH_LOAD_TRANSPORT must be cold or warm");
	}
	return transport;
};

const isLoopbackHostname = (hostname: string): boolean => {
	const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
};

export const validateCapacityEndpoint = (url: URL, transport: Transport): void => {
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("LIVE_MATCH_LOAD_URL must use http or https");
	}
	if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
		throw new Error("plaintext capacity runs require a loopback endpoint");
	}
	if (transport === "warm" && url.protocol !== "https:") {
		throw new Error("warm capacity runs require an https endpoint for HTTP/2 keep-alive");
	}
};

const endpoint = new URL(required("LIVE_MATCH_LOAD_URL"));
const serviceToken = required("LIVE_MATCH_GRAPHQL_SERVICE_TOKEN");
const contractHeader = "live-matches-v3";
const eventIdValue = process.env.LIVE_MATCH_LOAD_EVENT_ID?.trim();
const eventId = eventIdValue ? Number(eventIdValue) : undefined;
if (eventId !== undefined && (!Number.isSafeInteger(eventId) || eventId <= 0)) {
	throw new Error("LIVE_MATCH_LOAD_EVENT_ID must be a positive integer");
}

const mode = parseMode(option("--mode"));
const transport = parseTransport(option("--transport"));
validateCapacityEndpoint(endpoint, transport);
const metricsEndpointValue = process.env.LIVE_MATCH_LOAD_METRICS_URL?.trim();
const metricsEndpoint = metricsEndpointValue ? new URL(metricsEndpointValue) : null;
if (metricsEndpoint !== null) validateCapacityEndpoint(metricsEndpoint, "cold");
const metricsDeployHealthEndpoint = metricsEndpoint
	? new URL("/health/deploy", metricsEndpoint.origin)
	: null;
const stages = [
	...new Set(
		(process.env.LIVE_MATCH_LOAD_STAGES ?? "50,100,200,300")
			.split(",")
			.map((value) => Number(value.trim()))
			.filter((value) => Number.isSafeInteger(value) && value > 0)
	),
].sort((left, right) => left - right);
if (stages.length === 0 || stages.some((value) => value > 300)) {
	throw new Error("LIVE_MATCH_LOAD_STAGES must contain positive integers up to 300");
}
const stageSeconds = positiveInteger("LIVE_MATCH_LOAD_STAGE_SECONDS", 900);
const thinkMs = nonNegativeInteger("LIVE_MATCH_LOAD_THINK_MS", 100);
const timeoutMs = positiveInteger("LIVE_MATCH_LOAD_TIMEOUT_MS", 10_000);
const metricsIntervalMs = positiveInteger("LIVE_MATCH_LOAD_METRICS_INTERVAL_MS", 5_000);
const requestedRunId = process.env.LIVE_MATCH_LOAD_RUN_ID?.trim();
if (requestedRunId && !/^[A-Za-z0-9._-]{1,48}$/.test(requestedRunId)) {
	throw new Error(
		"LIVE_MATCH_LOAD_RUN_ID must contain only safe characters and be at most 48 chars"
	);
}
const runId = requestedRunId || `match-${Date.now().toString(36)}`;
const outputPath = option("--output") ?? process.env.LIVE_MATCH_LOAD_OUTPUT;
const requireReady = process.env.LIVE_MATCH_LOAD_REQUIRE_READY !== "false";
const expectedDeploySha = required("LIVE_MATCH_LOAD_DEPLOY_SHA").toLowerCase();
if (!/^[0-9a-f]{40}$/.test(expectedDeploySha)) {
	throw new Error("LIVE_MATCH_LOAD_DEPLOY_SHA must be the exact 40-character lowercase Git SHA");
}
const deployHealthEndpoint = new URL("/health/deploy", endpoint.origin);

const query =
	mode === "HEAD"
		? `query LiveMatchdayHead($eventId: Int) {
			liveMatchday(eventId: $eventId) {
				availability
				delivery { state servedFrom reasonCodes }
				snapshot {
					season eventId state
					revisions { deskPublicationId deskGeneration lifecycle fixtureIdentity scoreState detailPublicationId detailGeneration playerDetail }
					times { deskSourceCheckedAt deskContentUpdatedAt deskPublishedAt deskStaleAt detailSourceCheckedAt detailContentUpdatedAt detailPublishedAt detailStaleAt servedAt nextRefreshAt }
					detailDelivery { state servedFrom reasonCodes }
				}
			}
		}`
		: mode === "DESK"
			? `query LiveMatchdayDesk($eventId: Int) {
				liveMatchday(eventId: $eventId) {
					availability
					delivery { state servedFrom reasonCodes }
					snapshot {
					season eventId state
						revisions { deskPublicationId deskGeneration lifecycle fixtureIdentity scoreState detailPublicationId detailGeneration playerDetail }
						times { deskSourceCheckedAt deskContentUpdatedAt deskPublishedAt deskStaleAt detailSourceCheckedAt detailContentUpdatedAt detailPublishedAt detailStaleAt servedAt nextRefreshAt }
						detailDelivery { state servedFrom reasonCodes }
						matches { fixtureId eventId homeTeamId homeTeamName homeTeamShortName awayTeamId awayTeamName awayTeamShortName homeScore awayScore kickoffTime minutes started finished finishedProvisional }
					}
				}
			}`
			: `query LiveMatchdayFull($eventId: Int) {
				liveMatchday(eventId: $eventId) {
					availability
					delivery { state servedFrom reasonCodes }
					snapshot {
					season eventId state
						revisions { deskPublicationId deskGeneration lifecycle fixtureIdentity scoreState detailPublicationId detailGeneration playerDetail }
						times { deskSourceCheckedAt deskContentUpdatedAt deskPublishedAt deskStaleAt detailSourceCheckedAt detailContentUpdatedAt detailPublishedAt detailStaleAt servedAt nextRefreshAt }
						detailDelivery { state servedFrom reasonCodes }
						matches {
							fixtureId eventId homeTeamId homeTeamName homeTeamShortName awayTeamId awayTeamName awayTeamShortName homeScore awayScore kickoffTime minutes started finished finishedProvisional
							players { id webName position teamId price totalPoints stats { identifier value awardedPoints } }
						}
					}
				}}`;

const requestBody = JSON.stringify({
	query,
	variables: { eventId: eventId ?? null },
});

const percentile = (values: readonly number[], rank: number): number | null => {
	if (values.length === 0) return null;
	const sorted = [...values].sort((left, right) => left - right);
	const index = Math.min(sorted.length - 1, Math.ceil(rank * sorted.length) - 1);
	return sorted[Math.max(0, index)] ?? null;
};

// A capacity run can produce millions of responses. Keep a bounded uniform
// reservoir for quantiles while retaining exact counters and maxima. The
// report therefore remains useful without retaining every request object.
const MAX_QUANTILE_SAMPLES = 8192;

class BoundedQuantile {
	private readonly samples: number[] = [];
	private count = 0;
	private maximum: number | null = null;

	add(value: number): void {
		this.count += 1;
		this.maximum = this.maximum === null ? value : Math.max(this.maximum, value);
		if (this.samples.length < MAX_QUANTILE_SAMPLES) {
			this.samples.push(value);
			return;
		}
		const slot = Math.floor(Math.random() * this.count);
		if (slot < MAX_QUANTILE_SAMPLES) this.samples[slot] = value;
	}

	summary(): MetricSummary {
		return {
			count: this.count,
			p50: percentile(this.samples, 0.5),
			p95: percentile(this.samples, 0.95),
			p99: percentile(this.samples, 0.99),
			max: this.maximum,
		};
	}
}

type HeaderValue = string | string[] | number | number[] | undefined;

const headerValue = (headers: Record<string, HeaderValue>, name: string): string | undefined => {
	const value = headers[name.toLowerCase()];
	const first = Array.isArray(value) ? value[0] : value;
	return first === undefined ? undefined : String(first);
};

const decodeWith = (
	decoder: (body: Buffer, callback: (error: Error | null, decoded: Buffer) => void) => void,
	body: Buffer
): Promise<Buffer> =>
	new Promise((resolve, reject) => {
		decoder(body, (error, decoded) => {
			if (error) {
				reject(error);
				return;
			}
			resolve(decoded);
		});
	});

async function decodeBody(body: Buffer, contentEncoding: string | undefined): Promise<Buffer> {
	const encoding = contentEncoding?.toLowerCase().trim();
	if (!encoding || encoding === "identity") return body;
	if (encoding === "gzip" || encoding === "x-gzip") return decodeWith(gunzip, body);
	if (encoding === "br") return decodeWith(brotliDecompress, body);
	if (encoding === "deflate") return decodeWith(inflate, body);
	throw new Error(`unsupported content encoding: ${encoding}`);
}

type RawResponse = {
	status: number;
	ttfbMs: number;
	bodyDownloadMs: number;
	durationMs: number;
	encoded: Buffer;
	decoded: Buffer;
	decodeError: string | null;
	globalRateLimit: boolean;
	rateLimitScope: string | null;
};

const agent = false;

const MAX_HTTP2_SESSIONS = 16;

type Http2SessionSlot = {
	session: ClientHttp2Session;
	maxConcurrentStreams: number;
	activeStreams: number;
};

type Http2CapacityEvidence = Readonly<{
	requestedConcurrency: number;
	sessionCount: number;
	remoteMaxConcurrentStreams: readonly number[];
	effectiveConcurrentStreams: number;
	capacitySatisfied: boolean;
}>;

const http2Sessions: Http2SessionSlot[] = [];
let http2SessionPromise: Promise<ClientHttp2Session> | null = null;
let http2CapacityTarget: number | null = null;
let http2EnsurePromise: Promise<Http2CapacityEvidence> | null = null;
let http2Closing = false;
let http2RoundRobin = 0;
const http2UnusableSessions = new WeakSet<ClientHttp2Session>();
let http2CapacityEvidence: Http2CapacityEvidence | null = null;

const isHttp2SessionUsable = (session: ClientHttp2Session): boolean =>
	!session.closed && !session.destroyed && !http2UnusableSessions.has(session);

const removeHttp2Session = (session: ClientHttp2Session): void => {
	const index = http2Sessions.findIndex((slot) => slot.session === session);
	if (index < 0) return;
	http2Sessions.splice(index, 1);
	if (http2RoundRobin >= http2Sessions.length) http2RoundRobin = 0;
	scheduleHttp2CapacityReplenish();
};

const usableHttp2Slots = (): Http2SessionSlot[] => {
	for (const slot of [...http2Sessions]) {
		if (!isHttp2SessionUsable(slot.session)) removeHttp2Session(slot.session);
	}
	return http2Sessions.filter((slot) => isHttp2SessionUsable(slot.session));
};

const http2CapacityOf = (slots: readonly Http2SessionSlot[]): number =>
	slots.reduce((total, slot) => total + slot.maxConcurrentStreams, 0);

const createHttp2Session = (): Promise<ClientHttp2Session> =>
	new Promise((resolve, reject) => {
		let session: ClientHttp2Session | null = null;
		let settled = false;
		let connected = false;
		let settingsReceived = false;
		let advertisedMaxConcurrentStreams: number | null = null;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const finishReject = (error: Error) => {
			if (settled) return;
			settled = true;
			if (timer !== null) clearTimeout(timer);
			reject(error);
		};
		const onError = (error: Error) => finishReject(error);
		try {
			session = http2Connect(endpoint.origin, { rejectUnauthorized: true });
		} catch (error) {
			finishReject(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		session.on("error", onError);
		const maybeResolve = () => {
			if (
				settled ||
				session === null ||
				!connected ||
				!settingsReceived ||
				advertisedMaxConcurrentStreams === null
			)
				return;
			settled = true;
			if (timer !== null) clearTimeout(timer);
			http2Sessions.push({
				session,
				maxConcurrentStreams: advertisedMaxConcurrentStreams,
				activeStreams: 0,
			});
			resolve(session);
		};
		const onRemoteSettings = (settings: Settings) => {
			const currentSession = session;
			if (currentSession === null) return;
			const maxConcurrentStreams = settings.maxConcurrentStreams;
			if (
				typeof maxConcurrentStreams !== "number" ||
				!Number.isSafeInteger(maxConcurrentStreams) ||
				maxConcurrentStreams <= 0
			) {
				if (!settingsReceived) {
					finishReject(new Error("http2 peer did not advertise a usable maxConcurrentStreams"));
					if (!currentSession.closed && !currentSession.destroyed) currentSession.destroy();
				}
				return;
			}
			advertisedMaxConcurrentStreams = maxConcurrentStreams;
			settingsReceived = true;
			const index = http2Sessions.findIndex((slot) => slot.session === currentSession);
			if (index >= 0) {
				const slot = http2Sessions[index]!;
				http2Sessions[index] = { ...slot, maxConcurrentStreams };
				if (
					http2CapacityTarget !== null &&
					http2CapacityOf(usableHttp2Slots()) < http2CapacityTarget
				)
					scheduleHttp2CapacityReplenish();
			}
			maybeResolve();
		};
		session.once("connect", () => {
			connected = true;
			maybeResolve();
		});
		session.on("remoteSettings", onRemoteSettings);
		session.once("close", () => {
			removeHttp2Session(session!);
			if (!settled) finishReject(new Error("http2 session closed before peer settings"));
		});
		session.on("goaway", () => {
			http2UnusableSessions.add(session!);
			removeHttp2Session(session!);
			if (!session!.closed && !session!.destroyed) session!.close();
		});
		timer = setTimeout(() => {
			const error = new Error("http2 session timeout");
			finishReject(error);
			if (session && !session.closed && !session.destroyed) session.destroy();
		}, timeoutMs);
	});

const createSharedHttp2Session = (): Promise<ClientHttp2Session> => {
	if (http2SessionPromise) return http2SessionPromise;
	http2SessionPromise = createHttp2Session();
	const pending = http2SessionPromise;
	void pending.then(
		() => {
			if (http2SessionPromise === pending) http2SessionPromise = null;
		},
		() => {
			if (http2SessionPromise === pending) http2SessionPromise = null;
		}
	);
	return pending;
};

async function getHttp2Session(): Promise<ClientHttp2Session> {
	let slots = usableHttp2Slots();
	if (http2CapacityTarget !== null && http2CapacityOf(slots) < http2CapacityTarget) {
		await ensureHttp2Capacity(http2CapacityTarget);
		slots = usableHttp2Slots();
	}
	if (slots.length > 0) {
		const available = slots.filter((slot) => slot.activeStreams < slot.maxConcurrentStreams);
		const candidates = available.length > 0 ? available : slots;
		const slot = candidates[http2RoundRobin % candidates.length];
		http2RoundRobin = (http2RoundRobin + 1) % candidates.length;
		return slot!.session;
	}
	return createSharedHttp2Session();
}

const reserveHttp2Stream = (session: ClientHttp2Session): void => {
	const index = http2Sessions.findIndex((slot) => slot.session === session);
	if (index < 0) return;
	const slot = http2Sessions[index]!;
	http2Sessions[index] = { ...slot, activeStreams: slot.activeStreams + 1 };
};

const releaseHttp2Stream = (session: ClientHttp2Session): void => {
	const index = http2Sessions.findIndex((slot) => slot.session === session);
	if (index < 0) return;
	const slot = http2Sessions[index]!;
	http2Sessions[index] = { ...slot, activeStreams: Math.max(0, slot.activeStreams - 1) };
};

async function ensureHttp2Capacity(
	requestedConcurrency = Math.max(...stages)
): Promise<Http2CapacityEvidence> {
	if (http2Closing) throw new Error("HTTP/2 capacity pool is closing");
	const target = Math.max(http2CapacityTarget ?? 0, requestedConcurrency);
	http2CapacityTarget = target;
	if (http2EnsurePromise) return http2EnsurePromise;
	const pending = Promise.resolve().then(async (): Promise<Http2CapacityEvidence> => {
		while (
			http2CapacityOf(usableHttp2Slots()) < (http2CapacityTarget ?? target) &&
			http2Sessions.length < MAX_HTTP2_SESSIONS
		) {
			await createSharedHttp2Session();
		}
		const slots = usableHttp2Slots();
		const effectiveConcurrentStreams = http2CapacityOf(slots);
		const finalTarget = http2CapacityTarget ?? target;
		const evidence: Http2CapacityEvidence = {
			requestedConcurrency: finalTarget,
			sessionCount: slots.length,
			remoteMaxConcurrentStreams: slots.map((slot) => slot.maxConcurrentStreams),
			effectiveConcurrentStreams,
			capacitySatisfied: effectiveConcurrentStreams >= finalTarget,
		};
		http2CapacityEvidence = evidence;
		if (!evidence.capacitySatisfied) {
			throw new Error(
				`HTTP/2 peer stream capacity ${effectiveConcurrentStreams} is below requested concurrency ${finalTarget}`
			);
		}
		return evidence;
	});
	http2EnsurePromise = pending;
	try {
		return await pending;
	} finally {
		if (http2EnsurePromise === pending) http2EnsurePromise = null;
	}
}

function scheduleHttp2CapacityReplenish(): void {
	if (http2Closing || http2CapacityTarget === null || http2EnsurePromise !== null) return;
	void ensureHttp2Capacity(http2CapacityTarget).catch(() => {
		http2CapacityEvidence = null;
	});
}

function closeHttp2Session(): void {
	http2Closing = true;
	http2CapacityTarget = null;
	const sessions = http2Sessions.map((slot) => slot.session);
	http2Sessions.length = 0;
	http2RoundRobin = 0;
	for (const session of sessions) {
		if (!session.closed && !session.destroyed) session.close();
	}
}

function requestOnceHttp1(): Promise<RawResponse> {
	return new Promise((resolve) => {
		const startedAt = performance.now();
		let headersAt: number | null = null;
		let settled = false;
		let bodyEnded = false;
		let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
		const finish = (value: RawResponse) => {
			if (settled) return;
			settled = true;
			if (deadlineTimer !== null) {
				clearTimeout(deadlineTimer);
				deadlineTimer = null;
			}
			resolve(value);
		};
		const requester = endpoint.protocol === "https:" ? httpsRequest : httpRequest;
		const request = requester(
			{
				protocol: endpoint.protocol,
				hostname: endpoint.hostname,
				port: endpoint.port || undefined,
				path: `${endpoint.pathname}${endpoint.search}`,
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json",
					"accept-encoding": "gzip, br",
					"content-length": Buffer.byteLength(requestBody),
					"x-graphql-service-token": serviceToken,
					"x-letletme-contract": contractHeader,
					"x-request-id": `lm-${runId}-${randomUUID().slice(0, 8)}`.slice(0, 64),
					"user-agent": `LetLetMe-LiveMatch-Capacity/${runId}`,
					...(transport === "cold" ? { connection: "close" } : {}),
				},
				agent,
				...(endpoint.protocol === "https:" ? { rejectUnauthorized: true } : {}),
			},
			(response) => {
				headersAt = performance.now();
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer | string) => {
					chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				});
				response.on("end", () => {
					bodyEnded = true;
					const endedAt = performance.now();
					const encoded = Buffer.concat(chunks);
					const status = response.statusCode ?? 0;
					const rateLimitScope = headerValue(response.headers, "x-ratelimit-scope") ?? null;
					const timing = {
						ttfbMs: Math.max(0, (headersAt ?? endedAt) - startedAt),
						bodyDownloadMs: Math.max(0, endedAt - (headersAt ?? endedAt)),
						durationMs: Math.max(0, endedAt - startedAt),
					};
					void decodeBody(encoded, headerValue(response.headers, "content-encoding")).then(
						(decoded) => {
							finish({
								status,
								...timing,
								encoded,
								decoded,
								decodeError: null,
								globalRateLimit: status === 429 && rateLimitScope === "global",
								rateLimitScope,
							});
						},
						(error) => {
							finish({
								status,
								...timing,
								encoded,
								decoded: Buffer.alloc(0),
								decodeError: error instanceof Error ? error.message : String(error),
								globalRateLimit: status === 429 && rateLimitScope === "global",
								rateLimitScope,
							});
						}
					);
				});
				response.on("error", (error) => {
					if (bodyEnded) return;
					const now = performance.now();
					finish({
						status: 0,
						ttfbMs: Math.max(0, (headersAt ?? now) - startedAt),
						bodyDownloadMs: 0,
						durationMs: Math.max(0, now - startedAt),
						encoded: Buffer.alloc(0),
						decoded: Buffer.alloc(0),
						decodeError: error instanceof Error ? error.message : String(error),
						globalRateLimit: false,
						rateLimitScope: null,
					});
				});
			}
		);
		request.setTimeout(timeoutMs, () => {
			request.destroy(new Error("request timeout"));
		});
		request.on("error", (error) => {
			const now = performance.now();
			finish({
				status: 0,
				ttfbMs: Math.max(0, (headersAt ?? now) - startedAt),
				bodyDownloadMs: 0,
				durationMs: Math.max(0, now - startedAt),
				encoded: Buffer.alloc(0),
				decoded: Buffer.alloc(0),
				decodeError: error instanceof Error ? error.message : String(error),
				globalRateLimit: false,
				rateLimitScope: null,
			});
		});
		deadlineTimer = setTimeout(() => {
			request.destroy(new Error("request timeout"));
		}, timeoutMs);
		request.end(requestBody);
	});
}

function requestOnceHttp2(): Promise<RawResponse> {
	return new Promise((resolve) => {
		const startedAt = performance.now();
		let headersAt: number | null = null;
		let status = 0;
		let timeout: ReturnType<typeof setTimeout> | null = null;
		let settled = false;
		let bodyEnded = false;
		let sessionRetryUsed = false;
		let assignedSession: ClientHttp2Session | null = null;
		const finish = (value: RawResponse) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			if (assignedSession !== null) {
				releaseHttp2Stream(assignedSession);
				assignedSession = null;
			}
			resolve(value);
		};
		const fail = (error: unknown, now = performance.now()) => {
			finish({
				status: 0,
				ttfbMs: Math.max(0, (headersAt ?? now) - startedAt),
				bodyDownloadMs: 0,
				durationMs: Math.max(0, now - startedAt),
				encoded: Buffer.alloc(0),
				decoded: Buffer.alloc(0),
				decodeError: error instanceof Error ? error.message : String(error),
				globalRateLimit: false,
				rateLimitScope: null,
			});
		};

		const assignStream = (session: ClientHttp2Session): void => {
			if (!isHttp2SessionUsable(session)) {
				if (sessionRetryUsed) {
					fail(new Error("http2 session became unusable before request assignment"));
					return;
				}
				sessionRetryUsed = true;
				removeHttp2Session(session);
				void getHttp2Session().then(assignStream).catch(fail);
				return;
			}

			let stream;
			try {
				stream = session.request({
					":method": "POST",
					":path": `${endpoint.pathname}${endpoint.search}`,
					":authority": endpoint.host,
					"content-type": "application/json",
					accept: "application/json",
					"accept-encoding": "gzip, br",
					"content-length": String(Buffer.byteLength(requestBody)),
					"x-graphql-service-token": serviceToken,
					"x-letletme-contract": contractHeader,
					"x-request-id": `lm-${runId}-${randomUUID().slice(0, 8)}`.slice(0, 64),
					"user-agent": `LetLetMe-LiveMatch-Capacity/${runId}`,
				});
			} catch (error) {
				if (!sessionRetryUsed && !isHttp2SessionUsable(session)) {
					sessionRetryUsed = true;
					removeHttp2Session(session);
					void getHttp2Session().then(assignStream).catch(fail);
					return;
				}
				fail(error);
				return;
			}
			reserveHttp2Stream(session);
			assignedSession = session;

			const chunks: Buffer[] = [];
			let rateLimitScope: string | null = null;
			let contentEncoding: string | undefined;
			stream.once("response", (responseHeaders) => {
				headersAt = performance.now();
				status = Number(headerValue(responseHeaders, ":status") ?? 0);
				rateLimitScope = headerValue(responseHeaders, "x-ratelimit-scope") ?? null;
				contentEncoding = headerValue(responseHeaders, "content-encoding");
			});
			stream.on("data", (chunk: Buffer | string) => {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			});
			stream.once("end", () => {
				bodyEnded = true;
				if (assignedSession !== null) {
					releaseHttp2Stream(assignedSession);
					assignedSession = null;
				}
				const endedAt = performance.now();
				const encoded = Buffer.concat(chunks);
				const timing = {
					ttfbMs: Math.max(0, (headersAt ?? endedAt) - startedAt),
					bodyDownloadMs: Math.max(0, endedAt - (headersAt ?? endedAt)),
					durationMs: Math.max(0, endedAt - startedAt),
				};
				void decodeBody(encoded, contentEncoding).then(
					(decoded) => {
						finish({
							status,
							...timing,
							encoded,
							decoded,
							decodeError: null,
							globalRateLimit: status === 429 && rateLimitScope === "global",
							rateLimitScope,
						});
					},
					(error) => {
						finish({
							status,
							...timing,
							encoded,
							decoded: Buffer.alloc(0),
							decodeError: error instanceof Error ? error.message : String(error),
							globalRateLimit: status === 429 && rateLimitScope === "global",
							rateLimitScope,
						});
					}
				);
			});
			stream.once("error", (error) => {
				if (!bodyEnded) fail(error);
			});
			stream.once("close", () => {
				if (!settled && !bodyEnded)
					fail(new Error("http2 stream closed before response body completed"));
			});
			timeout = setTimeout(() => {
				stream.close(http2Constants.NGHTTP2_CANCEL);
				fail(new Error("request timeout"));
			}, timeoutMs);
			try {
				stream.end(requestBody);
			} catch (error) {
				fail(error);
			}
		};
		void getHttp2Session().then(assignStream).catch(fail);
	});
}

function requestOnce(): Promise<RawResponse> {
	return transport === "warm" ? requestOnceHttp2() : requestOnceHttp1();
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

function semanticError(body: unknown): string | null {
	if (!isRecord(body)) return "invalid_json";
	if (Array.isArray(body.errors) && body.errors.length > 0) return "graphql_errors";
	const data = isRecord(body.data) ? body.data : null;
	const root = data && isRecord(data.liveMatchday) ? data.liveMatchday : null;
	if (!root) return "missing_live_matchday";
	if (root.availability !== "READY") return requireReady ? "availability_not_ready" : null;
	const delivery = isRecord(root.delivery) ? root.delivery : null;
	const deliveryState = delivery?.state;
	if (deliveryState !== "FRESH" && deliveryState !== "FINAL") return "unhealthy_delivery";
	if (delivery?.servedFrom !== "REDIS_CURRENT") return "fallback_delivery";
	const snapshot = isRecord(root.snapshot) ? root.snapshot : null;
	if (!snapshot) return "ready_without_snapshot";
	if (mode === "FULL") {
		const detailDelivery = isRecord(snapshot.detailDelivery) ? snapshot.detailDelivery : null;
		const detailState = detailDelivery?.state;
		if (detailState !== "FRESH" && detailState !== "FINAL") return "unhealthy_detail_delivery";
		if (detailDelivery?.servedFrom !== "REDIS_CURRENT") return "fallback_detail_delivery";
	}
	if (eventId !== undefined && snapshot.eventId !== eventId) return "event_mismatch";
	if (mode === "HEAD") {
		return Object.prototype.hasOwnProperty.call(snapshot, "matches")
			? "head_contains_matches"
			: null;
	}
	const matches = Array.isArray(snapshot.matches) ? snapshot.matches : null;
	if (!matches) return "missing_matches";
	const fixtureIds = new Set<number>();
	for (const fixtureValue of matches) {
		if (!isRecord(fixtureValue)) return "invalid_fixture";
		const fixtureId = fixtureValue.fixtureId;
		if (
			typeof fixtureId !== "number" ||
			!Number.isSafeInteger(fixtureId) ||
			fixtureId <= 0 ||
			fixtureIds.has(fixtureId) ||
			fixtureValue.eventId !== snapshot.eventId
		)
			return "fixture_identity_mismatch";
		fixtureIds.add(fixtureId);
	}
	if (mode === "DESK") return null;
	let startedFixtureCount = 0;
	let playerRowCount = 0;
	for (const fixtureValue of matches) {
		if (!isRecord(fixtureValue)) return "invalid_fixture";
		const players = Array.isArray(fixtureValue.players) ? fixtureValue.players : null;
		if (!players) return "missing_players";
		const detailRequired =
			fixtureValue.started === true ||
			fixtureValue.finished === true ||
			fixtureValue.finishedProvisional === true ||
			(typeof fixtureValue.minutes === "number" && fixtureValue.minutes > 0);
		if (detailRequired) startedFixtureCount += 1;
		if (detailRequired && players.length === 0) return "started_fixture_without_players";
		const playerIds = new Set<number>();
		for (const playerValue of players) {
			if (!isRecord(playerValue)) return "invalid_player";
			const playerId = playerValue.id;
			if (
				typeof playerId !== "number" ||
				!Number.isSafeInteger(playerId) ||
				playerId <= 0 ||
				playerIds.has(playerId)
			) {
				return "player_identity_mismatch";
			}
			playerIds.add(playerId);
			if (
				typeof playerValue.price !== "number" ||
				!Number.isSafeInteger(playerValue.price) ||
				playerValue.price <= 0
			)
				return "invalid_player_price";
			if (!Array.isArray(playerValue.stats)) return "missing_stats";
			const identifiers = new Set<string>();
			let awardedTotal = 0;
			for (const statValue of playerValue.stats) {
				if (!isRecord(statValue)) return "invalid_stat";
				const identifier =
					typeof statValue.identifier === "string" ? statValue.identifier.trim().toLowerCase() : "";
				if (!identifier || identifiers.has(identifier)) return "duplicate_stat_identifier";
				if (
					typeof statValue.value !== "number" ||
					!Number.isFinite(statValue.value) ||
					typeof statValue.awardedPoints !== "number" ||
					!Number.isFinite(statValue.awardedPoints)
				)
					return "invalid_stat_value";
				identifiers.add(identifier);
				awardedTotal += statValue.awardedPoints;
			}
			if (
				typeof playerValue.totalPoints !== "number" ||
				!Number.isFinite(playerValue.totalPoints) ||
				Math.abs(awardedTotal - playerValue.totalPoints) > 1e-9
			)
				return "player_total_mismatch";
			playerRowCount += 1;
		}
	}
	if (startedFixtureCount === 0) return "full_requires_started_fixture";
	if (playerRowCount === 0) return "full_without_players";
	return null;
}

class ResponseAccumulator {
	private requests = 0;
	private semanticFailures = 0;
	private non429Errors = 0;
	private rateLimited429 = 0;
	private unknown429 = 0;
	private global429 = 0;
	private readonly statusCounts = new Map<number, number>();
	private readonly errorCodes = new Map<string, number>();
	private readonly rateLimitScopeCounts = new Map<string, number>();
	private readonly durations = new BoundedQuantile();
	private readonly ttfb = new BoundedQuantile();
	private readonly bodyDownload = new BoundedQuantile();
	private readonly encodedBytes = new BoundedQuantile();
	private readonly decodedBytes = new BoundedQuantile();

	record(sample: ResponseSample): void {
		this.requests += 1;
		this.statusCounts.set(sample.status, (this.statusCounts.get(sample.status) ?? 0) + 1);
		this.durations.add(sample.durationMs);
		this.ttfb.add(sample.ttfbMs);
		this.bodyDownload.add(sample.bodyDownloadMs);
		this.encodedBytes.add(sample.encodedBytes);
		this.decodedBytes.add(sample.decodedBytes);
		if (!sample.semanticOk) this.semanticFailures += 1;
		if (sample.errorCode) {
			this.errorCodes.set(sample.errorCode, (this.errorCodes.get(sample.errorCode) ?? 0) + 1);
		}
		if (
			sample.status <= 0 ||
			(sample.status >= 400 && sample.status !== 429) ||
			(sample.status < 400 && !sample.semanticOk)
		) {
			this.non429Errors += 1;
		}
		if (sample.status === 429) {
			this.rateLimited429 += 1;
			const scope = sample.rateLimitScope ?? "unknown";
			this.rateLimitScopeCounts.set(scope, (this.rateLimitScopeCounts.get(scope) ?? 0) + 1);
			if (sample.rateLimitScope === null) this.unknown429 += 1;
			if (sample.globalRateLimit) this.global429 += 1;
		}
	}

	report() {
		return {
			requests: this.requests,
			statusCounts: Object.fromEntries(
				[...this.statusCounts.entries()].map(([status, count]) => [String(status), count])
			),
			semanticFailures: this.semanticFailures,
			non429Errors: this.non429Errors,
			errorCodes: Object.fromEntries(this.errorCodes),
			rateLimitScopeCounts: Object.fromEntries(this.rateLimitScopeCounts),
			rateLimited429: this.rateLimited429,
			unknown429: this.unknown429,
			global429: this.global429,
			non429ErrorRate: this.requests === 0 ? 1 : this.non429Errors / this.requests,
			e2eMs: this.durations.summary(),
			ttfbMs: this.ttfb.summary(),
			bodyDownloadMs: this.bodyDownload.summary(),
			encodedBytes: this.encodedBytes.summary(),
			decodedBytes: this.decodedBytes.summary(),
		};
	}
}

const accumulatorsByStage = new Map(stages.map((stage) => [stage, new ResponseAccumulator()]));
const overallAccumulator = new ResponseAccumulator();
const metricObservations: MetricObservation[] = [];
let requestCount = 0;

async function runOne(stage: number): Promise<void> {
	const response = await requestOnce();
	let parsed: unknown = null;
	let parseError: string | null = response.decodeError;
	if (!parseError) {
		try {
			parsed = JSON.parse(response.decoded.toString("utf8")) as unknown;
		} catch (error) {
			parseError = error instanceof Error ? error.message : String(error);
		}
	}
	const semanticValidationError = parseError === null ? semanticError(parsed) : null;
	const sample: ResponseSample = {
		stage,
		status: response.status,
		ttfbMs: response.ttfbMs,
		bodyDownloadMs: response.bodyDownloadMs,
		durationMs: response.durationMs,
		encodedBytes: response.encoded.byteLength,
		decodedBytes: response.decoded.byteLength,
		semanticOk: parseError === null && semanticValidationError === null,
		errorCode: parseError ?? semanticValidationError,
		globalRateLimit: response.globalRateLimit,
		rateLimitScope: response.rateLimitScope,
	};
	requestCount += 1;
	const accumulator = accumulatorsByStage.get(stage);
	if (!accumulator) throw new Error(`missing accumulator for stage ${stage}`);
	accumulator.record(sample);
	overallAccumulator.record(sample);
}

async function runWorker(stage: number, deadline: number): Promise<void> {
	while (Date.now() < deadline) {
		await runOne(stage);
		if (thinkMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, thinkMs));
		}
	}
}

function metricValue(text: string, metric: string, requiredLabel?: string): number | null {
	for (const line of text.split("\n")) {
		const match = line.match(/^([A-Za-z_:][A-Za-z0-9_:]*)(\{([^}]*)\})?\s+([-+0-9.eE]+)$/);
		if (!match || match[1] !== metric) continue;
		const labels = match[3] ?? "";
		if (requiredLabel !== undefined && !labels.includes(requiredLabel)) continue;
		const value = Number(match[4]);
		if (Number.isFinite(value)) return value;
	}
	return null;
}

function metricFamilyPresent(text: string, metric: string): boolean {
	return text
		.split("\n")
		.some(
			(line) =>
				line.startsWith(`${metric}{`) ||
				line.startsWith(`${metric} `) ||
				line.startsWith(`# TYPE ${metric} `)
		);
}

function metricSum(text: string, metric: string, requiredLabel: string): number | null {
	let matched = false;
	let total = 0;
	for (const line of text.split("\n")) {
		const match = line.match(/^([A-Za-z_:][A-Za-z0-9_:]*)(\{([^}]*)\})?\s+([-+0-9.eE]+)$/);
		if (!match || match[1] !== metric) continue;
		const labels = match[3] ?? "";
		if (!labels.includes(requiredLabel)) continue;
		const value = Number(match[4]);
		if (!Number.isFinite(value)) continue;
		matched = true;
		total += value;
	}
	if (matched) return total;
	return metricFamilyPresent(text, metric) ? 0 : null;
}

type DeploymentIdentitySample = {
	phase: string;
	source: "graphql" | "metrics";
	observedSha: string | null;
	ok: boolean;
};

const deploymentIdentitySamples: DeploymentIdentitySample[] = [];
let deploymentIdentityFailure: string | null = null;

const verifyDeploymentIdentity = async (
	phase: string,
	healthEndpoint: URL,
	source: "graphql" | "metrics"
): Promise<boolean> => {
	if (deploymentIdentityFailure !== null) return false;
	try {
		const response = await fetch(healthEndpoint, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(timeoutMs),
		});
		const payload = (await response.json()) as unknown;
		const observedSha =
			isRecord(payload) && typeof payload.deploySha === "string"
				? payload.deploySha.toLowerCase()
				: null;
		const ok = response.ok && observedSha === expectedDeploySha;
		deploymentIdentitySamples.push({ phase, source, observedSha, ok });
		if (!ok) {
			deploymentIdentityFailure = `${phase} (${source}): /health/deploy did not report expected deploy SHA`;
			return false;
		}
		return true;
	} catch (error) {
		deploymentIdentitySamples.push({ phase, source, observedSha: null, ok: false });
		deploymentIdentityFailure = `${phase} (${source}): /health/deploy identity check failed (${error instanceof Error ? error.message : String(error)})`;
		return false;
	}
};

const verifyAllDeploymentIdentities = async (phase: string): Promise<boolean> => {
	const graphqlOk = await verifyDeploymentIdentity(phase, deployHealthEndpoint, "graphql");
	const metricsOk =
		metricsDeployHealthEndpoint === null
			? true
			: await verifyDeploymentIdentity(`${phase}-metrics`, metricsDeployHealthEndpoint, "metrics");
	return graphqlOk && metricsOk;
};

async function collectMetrics(): Promise<MetricObservation | null> {
	if (metricsEndpoint === null) return null;
	let observation: MetricObservation;
	try {
		const response = await fetch(metricsEndpoint, {
			headers: {
				...(process.env.LIVE_MATCH_LOAD_METRICS_TOKEN
					? { "x-metrics-token": process.env.LIVE_MATCH_LOAD_METRICS_TOKEN }
					: {}),
			},
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await response.text();
		const denied = metricSum(
			text,
			"graphql_rate_limit_v3_decisions_total",
			'scope="global",outcome="denied"'
		);
		const wouldDenied = metricSum(
			text,
			"graphql_rate_limit_v3_decisions_total",
			'scope="global",outcome="would_deny"'
		);
		observation = {
			at: new Date().toISOString(),
			poolWaiting: metricValue(text, "postgres_pool_clients", 'state="waiting"'),
			poolWaitEvents: metricValue(text, "postgres_pool_wait_events_total"),
			// The capacity gate covers enforced and shadow global denials. A
			// shadow would_deny is still evidence that the selected profile would
			// throttle this traffic, so it cannot disappear from this gate.
			globalDenied:
				denied === null && wouldDenied === null ? null : (denied ?? 0) + (wouldDenied ?? 0),
		};
	} catch {
		observation = {
			at: new Date().toISOString(),
			poolWaiting: null,
			poolWaitEvents: null,
			globalDenied: null,
		};
	}
	metricObservations.push(observation);
	return observation;
}

if (!(await verifyAllDeploymentIdentities("before-run"))) {
	throw new Error(deploymentIdentityFailure ?? "deployment identity check failed");
}
const initialMetrics = await collectMetrics();
const globalDeniedBaseline = initialMetrics?.globalDenied ?? null;
const poolWaitEventsBaseline = initialMetrics?.poolWaitEvents ?? null;
let monitoring = true;
const monitor = (async () => {
	while (monitoring) {
		await collectMetrics();
		if (monitoring) await new Promise((resolve) => setTimeout(resolve, metricsIntervalMs));
	}
})();

if (transport === "warm") await ensureHttp2Capacity();
const startedAt = new Date().toISOString();
let stageExecutionAborted = false;
for (const stage of stages) {
	if (!(await verifyAllDeploymentIdentities(`before-stage-${stage}`))) {
		stageExecutionAborted = true;
		break;
	}
	const deadline = Date.now() + stageSeconds * 1000;
	await Promise.all(Array.from({ length: stage }, () => runWorker(stage, deadline)));
	if (!(await verifyAllDeploymentIdentities(`after-stage-${stage}`))) {
		stageExecutionAborted = true;
		break;
	}
}
monitoring = false;
await monitor;
await collectMetrics();
closeHttp2Session();
if (!stageExecutionAborted && deploymentIdentityFailure === null) {
	await verifyAllDeploymentIdentities("after-run");
}

const stageReports = stages.map((stage) => ({
	concurrency: stage,
	durationSeconds: stageSeconds,
	...accumulatorsByStage.get(stage)!.report(),
}));
const overall = overallAccumulator.report();
const capacityStage = stageReports.find((report) => report.concurrency === 300);
const requiredCapacityStages = [50, 100, 200, 300];
const requiredStageHealth = requiredCapacityStages.map((concurrency) => {
	const report = stageReports.find((item) => item.concurrency === concurrency);
	if (!report) {
		return { concurrency, present: false, healthy: false, failures: ["stage_missing"] };
	}
	const failures: string[] = [];
	if (report.semanticFailures > 0) failures.push("semantic_failures");
	if (report.non429Errors > 0) failures.push("non429_errors");
	if (report.rateLimited429 > 0) failures.push("rate_limited_429");
	return { concurrency, present: true, healthy: failures.length === 0, failures };
});
const firstReadyStage = stageReports.find((report) => report.requests > 0);
const globalDeniedObservationsComplete =
	globalDeniedBaseline !== null &&
	metricObservations.length > 0 &&
	metricObservations.every((observation) => observation.globalDenied !== null);
const poolWaitEventObservationsComplete =
	poolWaitEventsBaseline !== null &&
	metricObservations.length > 0 &&
	metricObservations.every((observation) => observation.poolWaitEvents !== null);
let globalDeniedCounterResetDetected: boolean | null = null;
let globalDeniedDelta: number | null = null;
if (globalDeniedObservationsComplete) {
	let previous = globalDeniedBaseline!;
	let positiveDelta = 0;
	globalDeniedCounterResetDetected = false;
	for (const observation of metricObservations) {
		const current = observation.globalDenied!;
		if (current < previous) {
			globalDeniedCounterResetDetected = true;
			break;
		}
		positiveDelta = Math.max(positiveDelta, current - previous);
		previous = current;
	}
	if (!globalDeniedCounterResetDetected) globalDeniedDelta = positiveDelta;
}
let poolWaitEventCounterResetDetected: boolean | null = null;
let poolWaitEventsDelta: number | null = null;
if (poolWaitEventObservationsComplete) {
	let previous = poolWaitEventsBaseline!;
	let positiveDelta = 0;
	poolWaitEventCounterResetDetected = false;
	for (const observation of metricObservations) {
		const current = observation.poolWaitEvents!;
		if (current < previous) {
			poolWaitEventCounterResetDetected = true;
			break;
		}
		positiveDelta = Math.max(positiveDelta, current - previous);
		previous = current;
	}
	if (!poolWaitEventCounterResetDetected) poolWaitEventsDelta = positiveDelta;
}
const capacityGate = {
	allRequiredStagesPresent: [50, 100, 200, 300].every((stage) => stages.includes(stage)),
	requiredStagesHaveNoErrors: requiredStageHealth.every((stage) => stage.healthy),
	requiredStageHealth,
	stage300DurationSeconds: capacityStage?.durationSeconds ?? 0,
	stage300DurationRequirementMet: (capacityStage?.durationSeconds ?? 0) >= 900,
	stage300P95Under800Ms: (capacityStage?.e2eMs.p95 ?? Number.POSITIVE_INFINITY) < 800,
	stage300P99Under2s: (capacityStage?.e2eMs.p99 ?? Number.POSITIVE_INFINITY) < 2_000,
	non429ErrorRateUnderPoint1Percent: (capacityStage?.non429ErrorRate ?? 1) < 0.001,
	rateLimited429IsZero: (capacityStage?.rateLimited429 ?? 1) === 0,
	global429IsZero: (capacityStage?.global429 ?? 1) === 0 && (capacityStage?.unknown429 ?? 1) === 0,
	unknown429IsZero: (capacityStage?.unknown429 ?? 1) === 0,
	globalDeniedBaseline,
	globalDeniedDelta,
	globalDeniedObservationsComplete,
	globalDeniedCounterResetDetected,
	globalDeniedCounterResetFree:
		globalDeniedObservationsComplete && globalDeniedCounterResetDetected === false,
	globalDeniedDeltaIsZero: globalDeniedObservationsComplete && globalDeniedDelta === 0,
	globalDeniedIncludesShadow: true,
	poolWaitEventsBaseline,
	poolWaitEventsDelta,
	poolWaitEventObservationsComplete,
	poolWaitEventCounterResetDetected,
	deploymentIdentityPinned:
		deploymentIdentityFailure === null &&
		["graphql", ...(metricsEndpoint === null ? [] : ["metrics"])].every((source) => {
			const sourceSamples = deploymentIdentitySamples.filter((sample) => sample.source === source);
			return sourceSamples.length >= 2 && sourceSamples.every((sample) => sample.ok);
		}),
	stageExecutionAborted: stageExecutionAborted,
	readyValidationRequired: requireReady,
	dbPoolWaitingIsZero:
		metricObservations.length > 0 && metricObservations.every((sample) => sample.poolWaiting === 0),
	dbPoolWaitEventsZero:
		poolWaitEventObservationsComplete &&
		poolWaitEventCounterResetDetected === false &&
		poolWaitEventsDelta === 0,
	metricsObserved: metricObservations.length > 0,
	headroomEvidence:
		"requires the versioned rate-limit capacity profile; this harness does not invent headroom",
};

const capacityGatePassed = [
	capacityGate.allRequiredStagesPresent,
	capacityGate.requiredStagesHaveNoErrors,
	capacityGate.stage300DurationRequirementMet,
	capacityGate.stage300P95Under800Ms,
	capacityGate.stage300P99Under2s,
	capacityGate.non429ErrorRateUnderPoint1Percent,
	capacityGate.rateLimited429IsZero,
	capacityGate.global429IsZero,
	capacityGate.unknown429IsZero,
	capacityGate.globalDeniedCounterResetFree,
	capacityGate.globalDeniedDeltaIsZero,
	capacityGate.deploymentIdentityPinned,
	capacityGate.readyValidationRequired,
	capacityGate.dbPoolWaitingIsZero,
	capacityGate.dbPoolWaitEventsZero,
	capacityGate.metricsObserved,
].every(Boolean);

const report = {
	schemaVersion: 2,
	contract: contractHeader,
	runId,
	endpoint: `${endpoint.origin}${endpoint.pathname}`,
	mode,
	transport,
	http2Capacity: http2CapacityEvidence,
	eventId: eventId ?? null,
	startedAt,
	finishedAt: new Date().toISOString(),
	deploymentIdentity: {
		expectedSha: expectedDeploySha,
		healthEndpoint: `${deployHealthEndpoint.origin}${deployHealthEndpoint.pathname}`,
		metricsHealthEndpoint: metricsDeployHealthEndpoint
			? `${metricsDeployHealthEndpoint.origin}${metricsDeployHealthEndpoint.pathname}`
			: null,
		samples: deploymentIdentitySamples,
		failure: deploymentIdentityFailure,
	},
	requestCount,
	oneRequestPerSample: true,
	request: {
		includesTimingAndSemanticValidation: true,
		queryDoesNotIncludeSecrets: true,
		serviceTokenOmittedFromReport: true,
	},
	stages: stageReports,
	overall,
	firstObservedStage: firstReadyStage?.concurrency ?? null,
	capacityGate,
	metricObservations,
	notes: [
		"Cold uses a new node http/https request with agent:false and Connection: close; warm uses enough HTTPS HTTP/2 sessions to cover the peer-advertised stream capacity with multiplexed keep-alive streams.",
		"Warm HTTP/2 evidence records each peer maxConcurrentStreams and the summed effective capacity; the run fails before load if it cannot cover the requested stage concurrency.",
		"Run HEAD and FULL separately to produce separate evidence. A smoke override shorter than 900 seconds is diagnostic only.",
		"Encoded bytes are measured before decompression; decoded bytes are measured after decompression.",
		"Global denial evidence includes enforced denied and shadow would_deny counters.",
		"Every capacity stage is bounded by /health/deploy identity checks for LIVE_MATCH_LOAD_DEPLOY_SHA; a mismatch aborts the run and fails the gate.",
		"When metrics are configured, the metrics origin is independently pinned to the same deploy SHA before and around every required stage.",
		"Pool waiting is gated by both the sampled waiting gauge and the monotonic postgres_pool_wait_events_total counter; transient queue waits cannot disappear between scrapes.",
		"Any semantic, non-429, or client/workload 429 failure in a required stage fails the stepped capacity gate even if a later stage recovers.",
		"Quantiles use a bounded uniform reservoir; request counters, status counts, semantic failures, and maxima remain exact.",
	],
};

const serialized = JSON.stringify(report, null, 2);
if (outputPath) await writeFile(outputPath, `${serialized}\n`, "utf8");
console.log(serialized);
if (!capacityGatePassed) process.exitCode = 1;
