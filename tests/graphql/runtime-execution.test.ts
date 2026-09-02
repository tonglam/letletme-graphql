import { describe, expect, it } from "bun:test";
import { HeaderMap } from "@apollo/server";
import type { ApolloServer } from "@apollo/server";

import type { GraphQLContext } from "../../src/graphql/context";
import {
	executeGraphQLRequest,
	liveMatchdayExecutionFlightKey,
} from "../../src/graphql/runtime-execution";
import { RequestTiming } from "../../src/http/request-timing";

const responseHeaders = (): HeaderMap => {
	const headers = new HeaderMap();
	headers.set("content-type", "application/json");
	return headers;
};

const request = (): Request =>
	new Request("http://localhost/graphql", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	});

const context = {} as GraphQLContext;

describe("liveMatchday GraphQL execution coalescing", () => {
	it("keys the flight by season and the complete parsed request body", () => {
		const base = { query: "query { liveMatchday { availability } }", variables: { eventId: 2 } };
		const same = liveMatchdayExecutionFlightKey(base, "2627", "application/json");
		const differentSeason = liveMatchdayExecutionFlightKey(base, "2628", "application/json");
		const differentEvent = liveMatchdayExecutionFlightKey(
			{ ...base, variables: { eventId: 3 } },
			"2627",
			"application/json"
		);
		const differentAccept = liveMatchdayExecutionFlightKey(base, "2627", "multipart/mixed");

		expect(same).toMatch(/^live-matchday:[^:]+:2627:[0-9a-f]{64}$/);
		expect(differentSeason).not.toBe(same);
		expect(differentEvent).not.toBe(same);
		expect(differentAccept).not.toBe(same);
	});

	it("shares one overlapping complete execution and gives each caller a fresh response", async () => {
		let calls = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const apollo = {
			executeHTTPGraphQLRequest: async () => {
				calls += 1;
				await gate;
				return {
					status: 200,
					headers: responseHeaders(),
					body: { kind: "complete" as const, string: '{"data":{"liveMatchday":{}}}' },
				};
			},
		} as unknown as ApolloServer<GraphQLContext>;

		const run = (requestId: string) =>
			executeGraphQLRequest({
				apollo,
				request: request(),
				parsedBody: { query: "query { liveMatchday { availability } }" },
				context,
				requestTiming: new RequestTiming(),
				requestId,
				corsHeaders: {},
				responseFlightKey: "test-live-matchday-flight",
			});

		const first = run("request-one");
		await Promise.resolve();
		const second = run("request-two");
		await Promise.resolve();
		expect(calls).toBe(1);

		release();
		const [firstResult, secondResult] = await Promise.all([first, second]);
		expect(calls).toBe(1);
		expect(await firstResult.response.text()).toBe('{"data":{"liveMatchday":{}}}');
		expect(await secondResult.response.text()).toBe('{"data":{"liveMatchday":{}}}');
		expect(firstResult.response.headers.get("X-Request-Id")).toBe("request-one");
		expect(secondResult.response.headers.get("X-Request-Id")).toBe("request-two");
	});

	it("does not retain a completed result for a later request", async () => {
		let calls = 0;
		const apollo = {
			executeHTTPGraphQLRequest: async () => {
				calls += 1;
				return {
					status: 200,
					headers: responseHeaders(),
					body: { kind: "complete" as const, string: '{"data":{"liveMatchday":{}}}' },
				};
			},
		} as unknown as ApolloServer<GraphQLContext>;
		const run = () =>
			executeGraphQLRequest({
				apollo,
				request: request(),
				parsedBody: { query: "query { liveMatchday { availability } }" },
				context,
				requestTiming: new RequestTiming(),
				requestId: `request-${calls + 3}`,
				corsHeaders: {},
				responseFlightKey: "test-live-matchday-no-retained-result",
			});

		await run();
		await run();
		expect(calls).toBe(2);
	});

	it("does not share a rejected execution", async () => {
		let calls = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const apollo = {
			executeHTTPGraphQLRequest: async () => {
				calls += 1;
				await gate;
				throw new Error("execution failed");
			},
		} as unknown as ApolloServer<GraphQLContext>;
		const run = (requestId: string) =>
			executeGraphQLRequest({
				apollo,
				request: request(),
				parsedBody: { query: "query { liveMatchday { availability } }" },
				context,
				requestTiming: new RequestTiming(),
				requestId,
				corsHeaders: {},
				responseFlightKey: "test-live-matchday-rejected-flight",
			});

		const first = run("request-one");
		await Promise.resolve();
		const second = run("request-two");
		await Promise.resolve();
		expect(calls).toBe(1);

		release();
		const results = await Promise.allSettled([first, second]);
		expect(results[0]?.status).toBe("rejected");
		expect(results[1]?.status).toBe("rejected");
		if (results[0]?.status === "rejected") {
			expect(results[0].reason).toMatchObject({ message: "execution failed" });
		}
		if (results[1]?.status === "rejected") {
			expect(results[1].reason).toMatchObject({ message: "execution failed" });
		}
		expect(calls).toBe(2);
	});
});
