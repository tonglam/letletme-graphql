import { describe, expect, it } from "bun:test";
import { validateGraphQLRequestLimits } from "../../src/graphql/limits";
import { schema } from "../../src/graphql/schema";

describe("GraphQL request limits", () => {
	it("accepts an ordinary query", () => {
		const result = validateGraphQLRequestLimits({
			query: "query { events { id name } }",
		});
		expect(result).toMatchObject({ ok: true, rateLimitCostUnits: 1 });
	});

	it("charges weighted complexity in ten-point units", () => {
		const result = validateGraphQLRequestLimits({
			query: "query { players(limit: 100) { id } }",
		});
		expect(result).toMatchObject({
			ok: true,
			weightedComplexity: 200,
			rateLimitCostUnits: 20,
		});
	});

	it("charges schema-defaulted list sizes when callers omit the argument", () => {
		const result = validateGraphQLRequestLimits(
			{
				query: "query { players { id } }",
			},
			schema
		);
		expect(result).toMatchObject({
			ok: true,
			weightedComplexity: 100,
			rateLimitCostUnits: 10,
		});
	});

	it("sums heavy root floors, including aliases", () => {
		const result = validateGraphQLRequestLimits({
			query:
				"query { first: liveMatches { eventId } second: liveMatches { eventId } calcLivePointsForTournament(eventId: 1, tournamentId: 2) { meta { totalEntries } } }",
		});
		expect(result).toMatchObject({ ok: true, rateLimitCostUnits: 50 });
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
		expect(result).toMatchObject({ ok: true, rateLimitCostUnits: 500 });
	});

	it("rejects duplicate entry IDs before execution", () => {
		const result = validateGraphQLRequestLimits({
			query:
				"query Batch($entryIds: [Int!]!) { calcLivePointsForEntries(eventId: 1, entryIds: $entryIds) { meta { totalEntries } } }",
			variables: { entryIds: [7, 7] },
		});
		expect(result).toMatchObject({ ok: false, code: "DUPLICATE_ENTRY_IDS" });
	});

	it("applies variable defaults before enforcing the entry batch cap", () => {
		const ids = Array.from({ length: 501 }, (_, index) => index + 1).join(",");
		const result = validateGraphQLRequestLimits({
			query: `query Batch($entryIds: [Int!]! = [${ids}]) { calcLivePointsForEntries(eventId: 1, entryIds: $entryIds) { meta { totalEntries } } }`,
		});
		expect(result).toMatchObject({ ok: false, code: "QUERY_TOO_COMPLEX" });
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
			rateLimitCostUnits: 2,
		});
	});
});
