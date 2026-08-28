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
			["Proxy-Authorization: Basic proxy-secret", "Proxy-Authorization: [REDACTED]"],
			["X-Authorization: ApiKey custom-secret", "X-Authorization: [REDACTED]"],
			['Authorization: "Bearer token with spaces"', 'Authorization: "[REDACTED]"'],
			['authorization="opaque value with spaces"', 'authorization="[REDACTED]"'],
			[
				'Authorization: "Digest username=\\"alice\\", response=\\"secret\\""',
				'Authorization: "[REDACTED]"',
			],
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

	test("redacts prefixed secret keys and complete quoted values", () => {
		for (const [source, expected, credential] of [
			[
				'X-GraphQL-Service-Token: "service token with spaces"',
				'X-GraphQL-Service-Token: "[REDACTED]"',
				"service token with spaces",
			],
			[
				'LETLETME_DATA_API_KEY="correct horse battery staple"',
				'LETLETME_DATA_API_KEY="[REDACTED]"',
				"correct horse battery staple",
			],
			['token="part one \\"part two\\""', 'token="[REDACTED]"', 'part one \\"part two\\"'],
		] as const) {
			const sanitized = sanitizeLogText(source);
			expect(sanitized).toBe(expected);
			expect(sanitized).not.toContain(credential);
		}
	});
});
