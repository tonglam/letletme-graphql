import { describe, expect, it } from "bun:test";
import {
	parseGraphQLGetLimitPayload,
	validateGraphQLRequestLimits,
} from "../../src/graphql/limits";

describe("GraphQL request limits", () => {
	it("accepts an ordinary query", () => {
		const result = validateGraphQLRequestLimits({
			query: "query { events { id name } }",
		});
		expect(result.ok).toBe(true);
	});

	it("rejects more than five root fields", () => {
		const result = validateGraphQLRequestLimits({
			query:
				"query { a: events { id } b: events { id } c: events { id } d: events { id } e: events { id } f: events { id } }",
		});
		expect(result).toMatchObject({ ok: false, code: "QUERY_TOO_COMPLEX" });
	});

	it("rejects alias bombs", () => {
		const aliases = Array.from({ length: 21 }, (_, index) => `a${index}: id`).join(" ");
		const result = validateGraphQLRequestLimits({
			query: `query { events { ${aliases} } }`,
		});
		expect(result).toMatchObject({ ok: false, code: "QUERY_TOO_COMPLEX" });
	});

	it("rejects weighted entry batches over 500", () => {
		const result = validateGraphQLRequestLimits({
			query:
				"query Batch($entryIds: [Int!]!) { calcLivePointsForEntries(eventId: 1, entryIds: $entryIds) { results { entry } } }",
			variables: { entryIds: Array.from({ length: 501 }, (_, index) => index + 1) },
		});
		expect(result).toMatchObject({ ok: false, code: "QUERY_TOO_COMPLEX" });
	});

	it("accepts the documented 500-entry batch with a normal selection", () => {
		const result = validateGraphQLRequestLimits({
			query:
				"query Batch($entryIds: [Int!]!) { calcLivePointsForEntries(eventId: 1, entryIds: $entryIds) { meta { totalEntries } } }",
			variables: { entryIds: Array.from({ length: 500 }, (_, index) => index + 1) },
		});
		expect(result.ok).toBe(true);
	});

	it("applies variable defaults before enforcing the entry batch cap", () => {
		const ids = Array.from({ length: 501 }, (_, index) => index + 1).join(",");
		const result = validateGraphQLRequestLimits({
			query: `query Batch($entryIds: [Int!]! = [${ids}]) { calcLivePointsForEntries(eventId: 1, entryIds: $entryIds) { meta { totalEntries } } }`,
		});
		expect(result).toMatchObject({ ok: false, code: "QUERY_TOO_COMPLEX" });
	});

	it("includes GET variables in request-limit validation", () => {
		const params = new URLSearchParams({
			query:
				"query Batch($entryIds: [Int!]!) { calcLivePointsForEntries(eventId: 1, entryIds: $entryIds) { meta { totalEntries } } }",
			variables: JSON.stringify({
				entryIds: Array.from({ length: 501 }, (_, index) => index + 1),
			}),
		});
		const parsed = parseGraphQLGetLimitPayload(params);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(validateGraphQLRequestLimits(parsed.payload)).toMatchObject({
				ok: false,
				code: "QUERY_TOO_COMPLEX",
			});
		}
	});

	it("rejects malformed GET variables", () => {
		expect(parseGraphQLGetLimitPayload(new URLSearchParams({ variables: "{" }))).toEqual({
			ok: false,
		});
	});

	it("classifies legacy session issuance as a security mutation", () => {
		const result = validateGraphQLRequestLimits({
			query: 'mutation { createWechatApiSession(code: "single-use-code") { token } }',
		});
		expect(result).toMatchObject({
			ok: true,
			shape: "mutation",
			securityOperation: true,
			securityOperationCount: 1,
		});
	});

	it("counts every legacy session mutation in a GraphQL batch", () => {
		const result = validateGraphQLRequestLimits([
			{ query: 'mutation { createWechatApiSession(code: "one") { token } }' },
			{ query: 'mutation { createWechatApiSession(code: "two") { token } }' },
		]);

		expect(result).toMatchObject({
			ok: true,
			securityOperation: true,
			securityOperationCount: 2,
		});
	});
});
