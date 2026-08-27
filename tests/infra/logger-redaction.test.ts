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
});
