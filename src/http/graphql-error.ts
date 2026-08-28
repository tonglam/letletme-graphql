/**
 * Keep the public GraphQL error contract deliberately small. Resolver and
 * driver errors are logged server-side, but their messages, causes, SQL and
 * connection details must never cross the HTTP boundary.
 */
const SAFE_CLIENT_CODES = new Set([
	"BAD_USER_INPUT",
	"BATCHING_DISABLED",
	"DUPLICATE_ENTRY_IDS",
	"GRAPHQL_PARSE_FAILED",
	"GRAPHQL_VALIDATION_FAILED",
	"UNAUTHENTICATED",
	"FORBIDDEN",
	"VIEWER_ENTRY_REQUIRED",
	"INVALID_GRAPHQL_REQUEST",
	"INVALID_AUTH_CONTEXT",
	"INVALID_JSON",
	"PAYLOAD_TOO_LARGE",
	"RATE_LIMITED",
	"RATE_LIMIT_STORAGE_UNAVAILABLE",
	"REQUEST_TOO_LARGE",
	"METHOD_NOT_ALLOWED",
	"INGRESS_NOT_TRUSTED",
	"LIVE_BOARD_REVISION_GONE",
	"LIVE_EVENT_NOT_FOUND",
	"LIVE_PUBLICATION_UNAVAILABLE",
	"LIVE_REVISION_GONE",
	"NOT_FOUND",
	"PRICE_CHANGE_LIVE_REVISION_UNAVAILABLE",
	"QUERY_TOO_COMPLEX",
	"TOURNAMENT_INSIGHTS_NOT_READY",
	"TOURNAMENT_STANDINGS_NOT_READY",
	"UNTRUSTED_INGRESS",
	"DATA_UNAVAILABLE",
	"DEPENDENCY_UNAVAILABLE",
	"SEASON_AUTHORITY_UNAVAILABLE",
	"INTERNAL_SERVER_ERROR",
]);

const PUBLIC_MESSAGES: Record<string, string> = {
	DATA_UNAVAILABLE: "Gameweek data is temporarily unavailable",
	DEPENDENCY_UNAVAILABLE: "A required data dependency is temporarily unavailable",
	SEASON_AUTHORITY_UNAVAILABLE: "Current season metadata is temporarily unavailable",
	INTERNAL_SERVER_ERROR: "Internal server error",
};

type GraphQLWireError = {
	message?: unknown;
	extensions?: Record<string, unknown>;
	path?: unknown;
	locations?: unknown;
};

type GraphQLWirePayload = Record<string, unknown>;

const sanitizeWireError = (error: GraphQLWireError, requestId: string): GraphQLWireError => {
	const rawCode =
		typeof error.extensions?.code === "string" ? error.extensions.code : "INTERNAL_SERVER_ERROR";
	const code = SAFE_CLIENT_CODES.has(rawCode) ? rawCode : "INTERNAL_SERVER_ERROR";
	const message =
		PUBLIC_MESSAGES[code] ??
		(code === "RATE_LIMITED"
			? "Too many requests"
			: code === "UNAUTHENTICATED"
				? "Authentication required"
				: code === "FORBIDDEN"
					? "Forbidden"
					: SAFE_CLIENT_CODES.has(rawCode)
						? typeof error.message === "string"
							? error.message
							: "GraphQL request failed"
						: "Internal server error");
	const boardRevision =
		code === "LIVE_BOARD_REVISION_GONE" && typeof error.extensions?.boardRevision === "string"
			? error.extensions.boardRevision
			: undefined;
	return {
		message,
		extensions: {
			code,
			requestId,
			...(boardRevision === undefined ? {} : { boardRevision }),
		},
		...(Array.isArray(error.path) ? { path: error.path } : {}),
		...(Array.isArray(error.locations) ? { locations: error.locations } : {}),
	};
};

const sanitizeErrorArray = (value: unknown, requestId: string): unknown =>
	Array.isArray(value)
		? value.map((error) =>
				sanitizeWireError(
					error && typeof error === "object" ? (error as GraphQLWireError) : {},
					requestId
				)
			)
		: value;

const sanitizeIncrementalItems = (value: unknown, requestId: string): unknown => {
	if (!Array.isArray(value)) return value;
	return (value as unknown[]).map((item: unknown) => {
		if (!item || typeof item !== "object") return item;
		const record = item as GraphQLWirePayload;
		return Array.isArray(record.errors)
			? { ...record, errors: sanitizeErrorArray(record.errors, requestId) }
			: record;
	});
};

const sanitizeGraphQLPayload = (
	payload: GraphQLWirePayload,
	requestId: string
): GraphQLWirePayload => ({
	...payload,
	...(Array.isArray(payload.errors)
		? { errors: sanitizeErrorArray(payload.errors, requestId) }
		: {}),
	...(Array.isArray(payload.incremental)
		? { incremental: sanitizeIncrementalItems(payload.incremental, requestId) }
		: {}),
	...(Array.isArray(payload.completed)
		? { completed: sanitizeIncrementalItems(payload.completed, requestId) }
		: {}),
});

const internalErrorPayload = (requestId: string): GraphQLWirePayload => ({
	errors: [
		{
			message: "Internal server error",
			extensions: { code: "INTERNAL_SERVER_ERROR", requestId },
		},
	],
});

/** Sanitize a complete Apollo response while preserving useful client errors. */
export const sanitizeGraphQLResponseBody = (body: string, requestId: string): string => {
	try {
		const payload = JSON.parse(body) as unknown;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
			return JSON.stringify(internalErrorPayload(requestId));
		}
		return JSON.stringify(sanitizeGraphQLPayload(payload as GraphQLWirePayload, requestId));
	} catch {
		return JSON.stringify(internalErrorPayload(requestId));
	}
};

/**
 * Apollo emits one complete JSON payload per multipart chunk. Parse and
 * sanitize that payload before forwarding the framing. Malformed framing is a
 * hard failure: forwarding an unparsed chunk could disclose resolver details.
 */
export const sanitizeGraphQLMultipartChunk = (chunk: string, requestId: string): string => {
	const payloadStart = chunk.indexOf("\r\n\r\n");
	const boundaryStart = chunk.lastIndexOf("\r\n---");
	if (payloadStart < 0 || boundaryStart <= payloadStart + 4) {
		throw new Error("Invalid GraphQL multipart response framing");
	}
	const prefix = chunk.slice(0, payloadStart + 4);
	const payloadBody = chunk.slice(payloadStart + 4, boundaryStart);
	const suffix = chunk.slice(boundaryStart);
	let payload: unknown;
	try {
		payload = JSON.parse(payloadBody) as unknown;
	} catch {
		throw new Error("Invalid GraphQL multipart response payload");
	}
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new Error("Invalid GraphQL multipart response payload");
	}
	return `${prefix}${JSON.stringify(
		sanitizeGraphQLPayload(payload as GraphQLWirePayload, requestId)
	)}${suffix}`;
};
