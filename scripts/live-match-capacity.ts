import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
	connect as http2Connect,
	constants as http2Constants,
	type ClientHttp2Session,
} from "node:http2";
import { gunzipSync, brotliDecompressSync, inflateSync } from "node:zlib";
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

function decodeBody(body: Buffer, contentEncoding: string | undefined): Buffer {
	const encoding = contentEncoding?.toLowerCase().trim();
	if (!encoding || encoding === "identity") return body;
	if (encoding === "gzip" || encoding === "x-gzip") return gunzipSync(body);
	if (encoding === "br") return brotliDecompressSync(body);
	if (encoding === "deflate") return inflateSync(body);
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

let http2Session: ClientHttp2Session | null = null;
let http2SessionPromise: Promise<ClientHttp2Session> | null = null;

function getHttp2Session(): Promise<ClientHttp2Session> {
	if (http2Session && !http2Session.closed && !http2Session.destroyed) {
		return Promise.resolve(http2Session);
	}
	if (http2SessionPromise) return http2SessionPromise;

	http2SessionPromise = new Promise((resolve, reject) => {
		let session: ClientHttp2Session;
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const finishReject = (error: Error) => {
			if (settled) return;
			settled = true;
			if (timer !== null) clearTimeout(timer);
			reject(error);
		};
		const onError = (error: Error) => {
			finishReject(error);
		};
		try {
			session = http2Connect(endpoint.origin, { rejectUnauthorized: true });
		} catch (error) {
			finishReject(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		session.on("error", onError);
		session.once("connect", () => {
			if (settled) return;
			settled = true;
			if (timer !== null) clearTimeout(timer);
			http2Session = session;
			resolve(session);
		});
		session.once("close", () => {
			if (http2Session === session) http2Session = null;
		});
		timer = setTimeout(() => {
			const error = new Error("http2 session timeout");
			finishReject(error);
			if (!session.closed && !session.destroyed) session.destroy();
		}, timeoutMs);
	});
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
}

function closeHttp2Session(): void {
	const session = http2Session as ClientHttp2Session | null;
	http2Session = null;
	if (session && !session.closed && !session.destroyed) session.close();
}

function requestOnceHttp1(): Promise<RawResponse> {
	return new Promise((resolve) => {
		const startedAt = performance.now();
		let headersAt: number | null = null;
		let settled = false;
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
					const endedAt = performance.now();
					const encoded = Buffer.concat(chunks);
					let decoded: Buffer<ArrayBufferLike> = encoded;
					let decodeError: string | null = null;
					try {
						decoded = decodeBody(encoded, headerValue(response.headers, "content-encoding"));
					} catch (error) {
						decodeError = error instanceof Error ? error.message : String(error);
					}
					finish({
						status: response.statusCode ?? 0,
						ttfbMs: Math.max(0, (headersAt ?? endedAt) - startedAt),
						bodyDownloadMs: Math.max(0, endedAt - (headersAt ?? endedAt)),
						durationMs: Math.max(0, endedAt - startedAt),
						encoded,
						decoded,
						decodeError,
						globalRateLimit:
							response.statusCode === 429 &&
							headerValue(response.headers, "x-ratelimit-scope") === "global",
						rateLimitScope: headerValue(response.headers, "x-ratelimit-scope") ?? null,
					});
				});
				response.on("error", (error) => {
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
		const finish = (value: RawResponse) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
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

		void getHttp2Session()
			.then((session) => {
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
					fail(error);
					return;
				}

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
					const endedAt = performance.now();
					const encoded = Buffer.concat(chunks);
					let decoded: Buffer = encoded;
					let decodeError: string | null = null;
					try {
						decoded = decodeBody(encoded, contentEncoding);
					} catch (error) {
						decodeError = error instanceof Error ? error.message : String(error);
					}
					finish({
						status,
						ttfbMs: Math.max(0, (headersAt ?? endedAt) - startedAt),
						bodyDownloadMs: Math.max(0, endedAt - (headersAt ?? endedAt)),
						durationMs: Math.max(0, endedAt - startedAt),
						encoded,
						decoded,
						decodeError,
						globalRateLimit: status === 429 && rateLimitScope === "global",
						rateLimitScope,
					});
				});
				stream.once("error", fail);
				stream.once("close", () => {
					if (!settled) fail(new Error("http2 stream closed before response body completed"));
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
			})
			.catch((error) => fail(error));
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
	if (delivery?.servedFrom !== "REDIS_CURRENT") return "fallback_delivery";
	if (mode === "FULL") {
		const detailDelivery = isRecord(root.snapshot)
			? isRecord(root.snapshot.detailDelivery)
				? root.snapshot.detailDelivery
				: null
			: null;
		if (detailDelivery?.servedFrom !== "REDIS_CURRENT") return "fallback_detail_delivery";
	}
	const snapshot = isRecord(root.snapshot) ? root.snapshot : null;
	if (!snapshot) return "ready_without_snapshot";
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
	for (const fixtureValue of matches) {
		if (!isRecord(fixtureValue)) return "invalid_fixture";
		const players = Array.isArray(fixtureValue.players) ? fixtureValue.players : null;
		if (!players) return "missing_players";
		const detailRequired =
			fixtureValue.started === true ||
			fixtureValue.finished === true ||
			fixtureValue.finishedProvisional === true ||
			(typeof fixtureValue.minutes === "number" && fixtureValue.minutes > 0);
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
		}
	}
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

function metricValue(text: string, metric: string, requiredLabel: string): number | null {
	for (const line of text.split("\n")) {
		const match = line.match(/^([A-Za-z_:][A-Za-z0-9_:]*)(\{([^}]*)\})?\s+([-+0-9.eE]+)$/);
		if (!match || match[1] !== metric) continue;
		const labels = match[3] ?? "";
		if (!labels.includes(requiredLabel)) continue;
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

async function collectMetrics(): Promise<MetricObservation | null> {
	const metricsUrl = process.env.LIVE_MATCH_LOAD_METRICS_URL?.trim();
	if (!metricsUrl) return null;
	let observation: MetricObservation;
	try {
		const response = await fetch(metricsUrl, {
			headers: {
				...(process.env.LIVE_MATCH_LOAD_METRICS_TOKEN
					? { "x-metrics-token": process.env.LIVE_MATCH_LOAD_METRICS_TOKEN }
					: {}),
			},
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await response.text();
		observation = {
			at: new Date().toISOString(),
			poolWaiting: metricValue(text, "postgres_pool_clients", 'state="waiting"'),
			globalDenied: metricSum(
				text,
				"graphql_rate_limit_v3_decisions_total",
				'scope="global",outcome="denied"'
			),
		};
	} catch {
		observation = {
			at: new Date().toISOString(),
			poolWaiting: null,
			globalDenied: null,
		};
	}
	metricObservations.push(observation);
	return observation;
}

const initialMetrics = await collectMetrics();
const globalDeniedBaseline = initialMetrics?.globalDenied ?? null;
let monitoring = true;
const monitor = (async () => {
	while (monitoring) {
		await collectMetrics();
		if (monitoring) await new Promise((resolve) => setTimeout(resolve, metricsIntervalMs));
	}
})();

if (transport === "warm") await getHttp2Session();
const startedAt = new Date().toISOString();
for (const stage of stages) {
	const deadline = Date.now() + stageSeconds * 1000;
	await Promise.all(Array.from({ length: stage }, () => runWorker(stage, deadline)));
}
monitoring = false;
await monitor;
await collectMetrics();
closeHttp2Session();

const stageReports = stages.map((stage) => ({
	concurrency: stage,
	durationSeconds: stageSeconds,
	...accumulatorsByStage.get(stage)!.report(),
}));
const overall = overallAccumulator.report();
const capacityStage = stageReports.find((report) => report.concurrency === 300);
const firstReadyStage = stageReports.find((report) => report.requests > 0);
const globalDeniedObservationsComplete =
	globalDeniedBaseline !== null &&
	metricObservations.length > 0 &&
	metricObservations.every((observation) => observation.globalDenied !== null);
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
const capacityGate = {
	allRequiredStagesPresent: [50, 100, 200, 300].every((stage) => stages.includes(stage)),
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
	readyValidationRequired: requireReady,
	dbPoolWaitingIsZero:
		metricObservations.length > 0 && metricObservations.every((sample) => sample.poolWaiting === 0),
	metricsObserved: metricObservations.length > 0,
	headroomEvidence:
		"requires the versioned rate-limit capacity profile; this harness does not invent headroom",
};

const capacityGatePassed = [
	capacityGate.allRequiredStagesPresent,
	capacityGate.stage300DurationRequirementMet,
	capacityGate.stage300P95Under800Ms,
	capacityGate.stage300P99Under2s,
	capacityGate.non429ErrorRateUnderPoint1Percent,
	capacityGate.rateLimited429IsZero,
	capacityGate.global429IsZero,
	capacityGate.unknown429IsZero,
	capacityGate.globalDeniedCounterResetFree,
	capacityGate.globalDeniedDeltaIsZero,
	capacityGate.readyValidationRequired,
	capacityGate.dbPoolWaitingIsZero,
	capacityGate.metricsObserved,
].every(Boolean);

const report = {
	schemaVersion: 2,
	contract: contractHeader,
	runId,
	endpoint: `${endpoint.origin}${endpoint.pathname}`,
	mode,
	transport,
	eventId: eventId ?? null,
	startedAt,
	finishedAt: new Date().toISOString(),
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
		"Cold uses a new node http/https request with agent:false and Connection: close; warm uses one HTTPS HTTP/2 session with multiplexed keep-alive streams.",
		"Run HEAD and FULL separately to produce separate evidence. A smoke override shorter than 900 seconds is diagnostic only.",
		"Encoded bytes are measured before decompression; decoded bytes are measured after decompression.",
		"Quantiles use a bounded uniform reservoir; request counters, status counts, semantic failures, and maxima remain exact.",
	],
};

const serialized = JSON.stringify(report, null, 2);
if (outputPath) await writeFile(outputPath, `${serialized}\n`, "utf8");
console.log(serialized);
if (!capacityGatePassed) process.exitCode = 1;
