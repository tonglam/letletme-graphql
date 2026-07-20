import { describe, expect, it } from "bun:test";
import {
	MAX_REQUEST_BODY_BYTES,
	PayloadTooLargeError,
	readRequestBody,
	resolveClientIp,
	checkRateLimit,
} from "../../src/http/security";

describe("HTTP security boundaries", () => {
	it("uses the direct peer when no proxy hops are trusted", () => {
		const headers = new Headers({
			"x-forwarded-for": "198.51.100.9, 203.0.113.8",
			"x-real-ip": "198.51.100.10",
		});

		expect(resolveClientIp(headers, "192.0.2.4", 0)).toBe("192.0.2.4");
	});

	it("walks forwarding addresses from the trusted right edge", () => {
		const headers = new Headers({
			"x-forwarded-for": "198.51.100.9, 203.0.113.8",
		});

		expect(resolveClientIp(headers, "192.0.2.4", 1)).toBe("203.0.113.8");
		expect(resolveClientIp(headers, "192.0.2.4", 2)).toBe("198.51.100.9");
	});

	it("preserves IPv6 peers and strips bracketed proxy ports", () => {
		expect(resolveClientIp(new Headers(), "2001:db8::4", 0)).toBe("2001:db8::4");
		expect(resolveClientIp(new Headers(), "[2001:db8::4]:443", 0)).toBe("2001:db8::4");
	});

	it("falls back to the peer when a trusted forwarding hop is malformed", () => {
		const headers = new Headers({ "x-forwarded-for": "not-an-ip" });
		expect(resolveClientIp(headers, "192.0.2.4", 1)).toBe("192.0.2.4");
	});

	it("rejects an oversized declared request body", async () => {
		const request = new Request("http://localhost/graphql", {
			method: "POST",
			headers: { "content-length": String(MAX_REQUEST_BODY_BYTES + 1) },
			body: "{}",
		});

		expect(readRequestBody(request)).rejects.toBeInstanceOf(PayloadTooLargeError);
	});

	it("rejects an oversized streamed request body", async () => {
		const request = new Request("http://localhost/graphql", {
			method: "POST",
			body: "x".repeat(MAX_REQUEST_BODY_BYTES + 1),
		});

		expect(readRequestBody(request)).rejects.toBeInstanceOf(PayloadTooLargeError);
	});

	it("passes operation cost to Redis rate limiting", async () => {
		const calls: unknown[][] = [];
		const redis = {
			eval: async (...args: unknown[]) => {
				calls.push(args);
				return [2, 60];
			},
		} as never;

		const result = await checkRateLimit(redis, "security", 5, 60, 2);
		expect(result.allowed).toBe(true);
		expect(calls[0]?.slice(-2)).toEqual(["60", "2"]);
	});
});
