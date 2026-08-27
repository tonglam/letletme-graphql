import pino from "pino";
import { env } from "./env";
import { sanitizeErrorForLog } from "./log-sanitization";

export type Logger = pino.Logger;

export const logger: Logger = pino({
	level: env.LOG_LEVEL,
	base: {
		service: "letletme-graphql",
	},
	serializers: {
		err: sanitizeErrorForLog,
	},
	redact: {
		paths: [
			"password",
			"apiKey",
			"token",
			"authorization",
			"headers.authorization",
			"headers.x-api-key",
			"*.password",
			"*.apiKey",
			"*.token",
			"*.authorization",
		],
		censor: "[REDACTED]",
	},
});
