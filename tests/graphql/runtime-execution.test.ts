import { ExecutionScope } from "../../src/infra/execution-scope";
import { describe, expect, it } from "bun:test";
import { HeaderMap } from "@apollo/server";
import type { ApolloServer } from "@apollo/server";

import type { GraphQLContext } from "../../src/graphql/context";
import {
	executeGraphQLRequest,
	liveMatchdayExecutionFlightKey,
} from "../../src/graphql/runtime-execution";
import { RequestTiming } from "../../src/http/request-timing";
import { metrics } from "../../src/infra/metrics";

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

const liveMatchDeliveryCounterValue = async (): Promise<number> => {
	const delivery = await metrics.liveMatchDeliveryTotal.get();
	return (
		delivery.values.find(
			(value) =>
				value.labels.view === "FULL" &&
				value.labels.state === "FRESH" &&
				value.labels.served_from === "REDIS_CURRENT"
		)?.value ?? 0
	);
};

describe("liveMatchday GraphQL execution coalescing", () => {
	it("keys the flight by season and the complete parsed request body", () => {
		const base = { query: "query { liveMatchday { availability } }", variables: { eventId: 2 } };
		const transport = {
			method: "POST",
			accept: "application/json",
			contentType: "application/json",
			apolloRequirePreflight: "",
			apolloOperationName: "",
		};
		const key = (overrides: Partial<typeof transport> = {}) =>
			liveMatchdayExecutionFlightKey(base, "2627", { ...transport, ...overrides });
		const same = key();
		const differentSeason = liveMatchdayExecutionFlightKey(base, "2628", transport);
		const differentEvent = liveMatchdayExecutionFlightKey(
			{ ...base, variables: { eventId: 3 } },
			"2627",
			transport
		);
		const differentAccept = key({ accept: "multipart/mixed" });
		const differentContentType = key({ contentType: "text/plain" });
		const differentPreflight = key({ apolloRequirePreflight: "true" });
		const differentOperationHeader = key({ apolloOperationName: "LiveMatchday" });
		const differentMethod = key({ method: "GET" });

		expect(same).toMatch(/^live-matchday:[^:]+:2627:[0-9a-f]{64}$/);
		expect(differentSeason).not.toBe(same);
		expect(differentEvent).not.toBe(same);
		expect(differentAccept).not.toBe(same);
		expect(differentContentType).not.toBe(same);
		expect(differentPreflight).not.toBe(same);
		expect(differentOperationHeader).not.toBe(same);
		expect(differentMethod).not.toBe(same);
	});

	const shareableObservation = () => ({
		view: "FULL" as const,
		state: "FRESH" as const,
		servedFrom: "REDIS_CURRENT",
		shareUntilMs: null,
	});

	it("shares one overlapping complete execution and gives each caller a fresh response", async () => {
		const deliveryBefore = await liveMatchDeliveryCounterValue();
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
				responseFlightObservation: shareableObservation,
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
		const deliveryAfter = await liveMatchDeliveryCounterValue();
		expect(deliveryAfter - deliveryBefore).toBe(1);
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
				responseFlightObservation: shareableObservation,
			});

		await run();
		await run();
		expect(calls).toBe(2);
	});

	it("does not restore a response after its stale boundary", async () => {
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
				responseFlightKey: "test-live-matchday-stale-flight",
				responseFlightObservation: () => ({
					...shareableObservation(),
					shareUntilMs: Date.now() - 1,
				}),
			});

		const first = run("request-one");
		await Promise.resolve();
		const second = run("request-two");
		await Promise.resolve();
		expect(calls).toBe(1);

		release();
		await Promise.all([first, second]);
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
				responseFlightObservation: shareableObservation,
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

describe("live flight cancellation ownership", () => {
	it("detaches one waiter, preserves the task deadline, and cancels when the last waiter leaves", async () => {
		let finish!: () => void;
		let task: ExecutionScope | undefined;
		let calls = 0;
		const apollo = {
			executeHTTPGraphQLRequest: async (options: { context: () => Promise<GraphQLContext> }) => {
				calls++;
				task = (await options.context()).executionScope;
				await new Promise<void>((resolve) => {
					finish = resolve;
				});
				return {
					status: 200,
					headers: responseHeaders(),
					body: { kind: "complete", string: '{"data":{}}' },
				};
			},
		} as unknown as ApolloServer<GraphQLContext>;
		const run = (scope: ExecutionScope, key: string) =>
			scope.run(() =>
				executeGraphQLRequest({
					apollo,
					request: request(),
					parsedBody: {},
					context: { executionScope: scope } as GraphQLContext,
					requestTiming: new RequestTiming(),
					requestId: "scope-test",
					corsHeaders: {},
					responseFlightKey: key,
					responseFlightObservation: () => ({
						view: "FULL",
						state: "FRESH",
						servedFrom: "REDIS_CURRENT",
						shareUntilMs: null,
					}),
				})
			);
		const a = new ExecutionScope(Date.now() + 500);
		const b = new ExecutionScope(Date.now() + 1000);
		const first = run(a, "cancel-one");
		const second = run(b, "cancel-one");
		await Bun.sleep(1);
		const deadline = task?.deadlineAt;
		a.cancel();
		await expect(first).rejects.toThrow();
		expect(task?.signal.aborted).toBe(false);
		expect(task?.deadlineAt).toBe(deadline);
		finish();
		expect((await second).response.status).toBe(200);
		expect(calls).toBe(1);
		a.dispose();
		b.dispose();
		const c = new ExecutionScope();
		const d = new ExecutionScope();
		const third = run(c, "cancel-all");
		const fourth = run(d, "cancel-all");
		await Bun.sleep(1);
		const endC = third.catch((error: unknown) => error);
		const endD = fourth.catch((error: unknown) => error);
		c.cancel();
		d.cancel();
		await Promise.all([endC, endD]);
		expect(task?.signal.aborted).toBe(true);
		finish();
		c.dispose();
		d.dispose();
	});

	it("retries under a later caller budget after the owner flight expires", async () => {
		let calls = 0;
		const apollo = {
			executeHTTPGraphQLRequest: async () => {
				calls++;
				if (calls === 1) await Bun.sleep(40);
				return {
					status: 200,
					headers: responseHeaders(),
					body: { kind: "complete", string: '{"data":{}}' },
				};
			},
		} as unknown as ApolloServer<GraphQLContext>;
		const run = (scope: ExecutionScope) =>
			scope.run(() =>
				executeGraphQLRequest({
					apollo,
					request: request(),
					parsedBody: {},
					context: { executionScope: scope } as GraphQLContext,
					requestTiming: new RequestTiming(),
					requestId: "budget-test",
					corsHeaders: {},
					responseFlightKey: "later-budget-flight",
					responseFlightObservation: () => ({
						view: "FULL",
						state: "FRESH",
						servedFrom: "REDIS_CURRENT",
						shareUntilMs: null,
					}),
				})
			);
		const early = new ExecutionScope(Date.now() + 20);
		const late = new ExecutionScope(Date.now() + 250);
		const first = run(early);
		await Bun.sleep(2);
		const second = run(late);
		const [firstResult, secondResult] = await Promise.allSettled([first, second]);
		expect(firstResult.status).toBe("rejected");
		expect(secondResult.status).toBe("fulfilled");
		if (secondResult.status === "fulfilled") expect(secondResult.value.response.status).toBe(200);
		expect(calls).toBe(2);
		early.dispose();
		late.dispose();
	});
});

it("keeps a non-shared streaming owner alive when another waiter falls back", async () => {
	let finish!: () => void;
	const gate = new Promise<void>((resolve) => {
		finish = resolve;
	});
	let task: ExecutionScope | undefined;
	let calls = 0;
	const apollo = {
		executeHTTPGraphQLRequest: async (options: { context: () => Promise<GraphQLContext> }) => {
			const ctx = await options.context();
			if (++calls > 1)
				return {
					status: 200,
					headers: responseHeaders(),
					body: { kind: "complete", string: '{"data":{}}' },
				};
			task = ctx.executionScope;
			return {
				status: 200,
				headers: responseHeaders(),
				body: {
					kind: "chunked",
					asyncIterator: (async function* () {
						await gate;
						yield '---\r\nContent-Type: application/json\r\n\r\n{"data":{}}\r\n-----\r\n';
					})(),
				},
			};
		},
	} as unknown as ApolloServer<GraphQLContext>;
	const a = new ExecutionScope();
	const b = new ExecutionScope();
	const run = (scope: ExecutionScope) =>
		executeGraphQLRequest({
			apollo,
			request: request(),
			parsedBody: {},
			context: { executionScope: scope } as GraphQLContext,
			requestTiming: new RequestTiming(),
			requestId: "stream",
			corsHeaders: {},
			responseFlightKey: "stream-owner",
			responseFlightObservation: () => null,
		});
	const first = run(a);
	const second = run(b);
	const [owner, waiter] = await Promise.all([first, second]);
	expect(waiter.response.status).toBe(200);
	expect(task?.signal.aborted).toBe(false);
	finish();
	await owner.response.text();
	expect(task?.signal.aborted).toBe(true);
	a.dispose();
	b.dispose();
});
