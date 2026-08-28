import { describe, expect, test } from "bun:test";
import { sanitizeErrorForLog, sanitizeLogText } from "../../src/infra/log-sanitization";

describe("server log redaction", () => {
	test("removes connection URLs, credentials and internal hosts", () => {
		const sanitized = sanitizeLogText(
			"redis://user:secret@cache.internal:6379 password=hunter2 token=abc host=db.internal:5432 getaddrinfo ENOTFOUND postgres.service.internal connect ECONNREFUSED [2001:db8::1]:5432"
		);
		expect(sanitized).not.toContain("secret");
		expect(sanitized).not.toContain("hunter2");
		expect(sanitized).not.toContain("abc");
		expect(sanitized).not.toContain("cache.internal");
		expect(sanitized).not.toContain("db.internal");
		expect(sanitized).not.toContain("postgres.service.internal");
		expect(sanitized).not.toContain("2001:db8::1");
	});

	test("does not serialize stack, cause or SQL text from Error objects", () => {
		const cause = new Error("postgresql://admin:password@db.internal:5432/letletme");
		const error = new Error("select password from accounts", { cause });
		error.stack = "stack with password=secret";
		const sanitized = sanitizeErrorForLog(error);
		expect(sanitized).toEqual({
			type: "Error",
			message: "Database operation failed",
		});
		expect(sanitized).not.toHaveProperty("stack");
		expect(sanitized).not.toHaveProperty("cause");
	});

	test("removes complete Authorization credentials including spaced schemes", () => {
		for (const [source, expected] of [
			["Authorization: Bearer super-secret-token", "Authorization: [REDACTED]"],
			["authorization=Basic dXNlcjpwYXNz", "authorization=[REDACTED]"],
		] as const) {
			const sanitized = sanitizeLogText(source);
			expect(sanitized).toBe(expected);
			expect(sanitized).not.toContain("super-secret-token");
			expect(sanitized).not.toContain("dXNlcjpwYXNz");
		}
	});

	test("removes schemes and credentials from generic secret assignments", () => {
		for (const [source, expected] of [
			["token: Bearer super-secret-token", "token: [REDACTED]"],
			["api-key=Basic dXNlcjpwYXNz", "api-key=[REDACTED]"],
		] as const) {
			const sanitized = sanitizeLogText(source);
			expect(sanitized).toBe(expected);
			expect(sanitized).not.toContain("super-secret-token");
			expect(sanitized).not.toContain("dXNlcjpwYXNz");
		}
	});

	test("removes credentials from serialized JSON error fields", () => {
		for (const [source, expected, credential] of [
			[
				'{"authorization":"Bearer serialized-secret"}',
				'{"authorization":"[REDACTED]"}',
				"serialized-secret",
			],
			['{"token":"super-secret"}', '{"token":"[REDACTED]"}', "super-secret"],
			["{'api-key':'Basic encoded-secret'}", "{'api-key':'[REDACTED]'}", "encoded-secret"],
		] as const) {
			const sanitized = sanitizeLogText(source);
			expect(sanitized).toBe(expected);
			expect(sanitized).not.toContain(credential);
		}
	});

	test("redacts quoted credentials containing whitespace", () => {
		for (const [source, expected, credential] of [
			[
				'{"password":"correct horse battery staple"}',
				'{"password":"[REDACTED]"}',
				"correct horse battery staple",
			],
			[
				"{'token':'Bearer correct horse battery staple'}",
				"{'token':'[REDACTED]'}",
				"correct horse battery staple",
			],
			[
				'{"password":"correct \' horse battery staple"}',
				'{"password":"[REDACTED]"}',
				"correct ' horse battery staple",
			],
		] as const) {
			const sanitized = sanitizeLogText(source);
			expect(sanitized).toBe(expected);
			expect(sanitized).not.toContain(credential);
		}
	});

	test("redacts credentials in prefixed environment variable names", () => {
		for (const [source, expected, credential] of [
			[
				"GRAPHQL_SERVICE_TOKEN=super-secret-token",
				"GRAPHQL_SERVICE_TOKEN=[REDACTED]",
				"super-secret-token",
			],
			[
				'LETLETME_DATA_API_KEY="correct horse battery staple"',
				'LETLETME_DATA_API_KEY="[REDACTED]"',
				"correct horse battery staple",
			],
			["BACKEND_PROXY_SECRET=proxy-secret", "BACKEND_PROXY_SECRET=[REDACTED]", "proxy-secret"],
		] as const) {
			const sanitized = sanitizeLogText(source);
			expect(sanitized).toBe(expected);
			expect(sanitized).not.toContain(credential);
		}
	});
});
