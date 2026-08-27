import { describe, expect, test } from "bun:test";
import {
	sanitizeGraphQLMultipartChunk,
	sanitizeGraphQLResponseBody,
} from "../../src/http/graphql-error";

describe("GraphQL public error sanitization", () => {
	test("redacts unknown resolver and database details", () => {
		const body = sanitizeGraphQLResponseBody(
			JSON.stringify({
				data: null,
				errors: [
					{
						message: "select * from users at db.internal:5432 password=secret",
						extensions: { code: "INTERNAL_DB_ERROR", cause: "socket details" },
					},
				],
			}),
			"req-123"
		);
		const parsed = JSON.parse(body) as { errors: unknown[] };
		expect(parsed.errors).toEqual([
			{
				message: "Internal server error",
				extensions: { code: "INTERNAL_SERVER_ERROR", requestId: "req-123" },
			},
		]);
		expect(body).not.toContain("db.internal");
		expect(body).not.toContain("secret");
	});

	test("preserves stable client errors but normalizes dependency messages", () => {
		const body = sanitizeGraphQLResponseBody(
			JSON.stringify({
				errors: [
					{ message: "bad argument", extensions: { code: "BAD_USER_INPUT" } },
					{ message: "sql timeout", extensions: { code: "DEPENDENCY_UNAVAILABLE" } },
				],
			}),
			"req-456"
		);
		expect((JSON.parse(body) as { errors: unknown[] }).errors).toEqual([
			{
				message: "bad argument",
				extensions: { code: "BAD_USER_INPUT", requestId: "req-456" },
			},
			{
				message: "A required data dependency is temporarily unavailable",
				extensions: { code: "DEPENDENCY_UNAVAILABLE", requestId: "req-456" },
			},
		]);
	});

	test("preserves intentional domain codes while dropping private extensions", () => {
		const body = sanitizeGraphQLResponseBody(
			JSON.stringify({
				errors: [
					{
						message: "Requested live revision has expired",
						extensions: {
							code: "LIVE_REVISION_GONE",
							http: { status: 410 },
							cause: "redis://secret@cache.internal",
						},
					},
				],
			}),
			"req-domain"
		);

		expect((JSON.parse(body) as { errors: unknown[] }).errors).toEqual([
			{
				message: "Requested live revision has expired",
				extensions: { code: "LIVE_REVISION_GONE", requestId: "req-domain" },
			},
		]);
		expect(body).not.toContain("cache.internal");
		expect(body).not.toContain("cause");
		expect(body).not.toContain("http");
	});

	test("preserves the public live-board replacement revision only for its stable code", () => {
		const body = sanitizeGraphQLResponseBody(
			JSON.stringify({
				errors: [
					{
						message: "Requested board revision has expired",
						extensions: {
							code: "LIVE_BOARD_REVISION_GONE",
							boardRevision: "board-revision-42",
							cause: "redis://secret@cache.internal",
						},
					},
				],
			}),
			"req-board"
		);

		expect((JSON.parse(body) as { errors: unknown[] }).errors).toEqual([
			{
				message: "Requested board revision has expired",
				extensions: {
					code: "LIVE_BOARD_REVISION_GONE",
					requestId: "req-board",
					boardRevision: "board-revision-42",
				},
			},
		]);
		expect(body).not.toContain("cache.internal");
	});

	test("redacts resolver details in incremental and completed multipart errors", () => {
		const chunk =
			'content-type: application/json; charset=utf-8\r\n\r\n{"hasNext":false,"incremental":[{"id":"0","data":null,"errors":[{"message":"select secret from db.internal","extensions":{"code":"POSTGRES_FAILURE","stack":"private"}}]}],"completed":[{"id":"1","errors":[{"message":"redis://password@cache.internal","extensions":{"code":"DEPENDENCY_UNAVAILABLE","cause":"private"}}]}]}\r\n-----\r\n';
		const sanitized = sanitizeGraphQLMultipartChunk(chunk, "req-stream");
		expect(sanitized).not.toContain("db.internal");
		expect(sanitized).not.toContain("password");
		expect(sanitized).not.toContain("stack");
		expect(sanitized).not.toContain("cause");
		expect(sanitized).toContain(
			'"extensions":{"code":"INTERNAL_SERVER_ERROR","requestId":"req-stream"}'
		);
		expect(sanitized).toContain(
			'"extensions":{"code":"DEPENDENCY_UNAVAILABLE","requestId":"req-stream"}'
		);
	});

	test("fails closed instead of forwarding malformed multipart payloads", () => {
		expect(() =>
			sanitizeGraphQLMultipartChunk(
				"content-type: application/json\r\n\r\nnot-json password=secret\r\n-----\r\n",
				"req-bad-stream"
			)
		).toThrow("Invalid GraphQL multipart response payload");
	});
});
