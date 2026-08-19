import { describe, expect, it } from "bun:test";
import { validateGraphQLTransportPayload } from "../../src/http/graphql-request";

describe("GraphQL transport payload", () => {
	it("accepts a non-empty query object", () => {
		expect(validateGraphQLTransportPayload({ query: "query { events { id } }" })).toBeNull();
	});

	it("rejects batches and malformed transport shapes", () => {
		expect(validateGraphQLTransportPayload([{ query: "query { events { id } }" }])).toEqual({
			code: "BATCHING_DISABLED",
			message: "GraphQL request batching is disabled",
		});
		for (const body of [null, {}, { query: "" }, { query: "   " }, { query: 42 }, "query"]) {
			expect(validateGraphQLTransportPayload(body)).toMatchObject({
				code: "INVALID_GRAPHQL_REQUEST",
			});
		}
	});
});
