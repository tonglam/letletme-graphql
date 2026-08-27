const DATABASE_STATEMENT =
	/\b(?:select|insert\s+into|update\s+\S+\s+set|delete\s+from|alter\s+table|create\s+table|drop\s+table)\b/i;
const CONNECTION_URL = /\b(?:postgres(?:ql)?|redis|rediss):\/\/[^\s"']+/gi;
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)([^@\s/]+)@/gi;
const SECRET_ASSIGNMENT =
	/\b(password|passwd|pwd|token|secret|api[_-]?key|authorization)(\s*[=:]\s*)([^\s,;]+)/gi;
const NETWORK_HOST =
	/\b(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|[a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d{1,5})?\b/gi;
const BRACKETED_IPV6 = /\[[0-9a-f:]+\](?::\d{1,5})?/gi;

export const sanitizeLogText = (value: string): string => {
	if (DATABASE_STATEMENT.test(value)) return "Database operation failed";
	return value
		.replace(CONNECTION_URL, (url) => `${url.split(":", 1)[0]}://[REDACTED]`)
		.replace(URL_CREDENTIALS, "$1[REDACTED]@")
		.replace(SECRET_ASSIGNMENT, "$1$2[REDACTED]")
		.replace(NETWORK_HOST, "[REDACTED_HOST]")
		.replace(BRACKETED_IPV6, "[REDACTED_HOST]")
		.slice(0, 500);
};

/**
 * Pino's default Error serializer includes stack and cause. Those fields can
 * contain SQL, connection URLs, credentials and internal hosts, so retain only
 * a bounded, scrubbed operational summary.
 */
export const sanitizeErrorForLog = (value: unknown): Record<string, unknown> => {
	if (value instanceof Error) {
		const code = (value as Error & { code?: unknown }).code;
		return {
			type: sanitizeLogText(value.name || "Error"),
			message: sanitizeLogText(value.message || "Operation failed"),
			...(typeof code === "string" || typeof code === "number" ? { code } : {}),
		};
	}
	if (typeof value === "string") {
		return { type: "Error", message: sanitizeLogText(value) };
	}
	return { type: "Error", message: "Operation failed" };
};
