import { afterEach, expect, test } from "bun:test";
import { ApolloServer, type ApolloServerPlugin } from "@apollo/server";
import { createDeprecatedSchemaUsageExecutionListener } from "../../src/graphql/deprecation-observability";
import { metrics } from "../../src/infra/metrics";

type TestContext = {
	deprecatedSymbols?: readonly string[];
	deprecatedSymbolOwners?: Readonly<Record<string, readonly string[]>>;
};
const servers: ApolloServer<TestContext>[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.stop()));
});

test("deprecated GraphQL schema usages use a controlled symbol label", async () => {
	metrics.graphqlDeprecatedSchemaUsages.labels("LiveCalcData.rank").inc();
	const rendered = await metrics.registry.metrics();
	expect(rendered).toContain(
		'graphql_deprecated_schema_usages_total{symbol="LiveCalcData.rank"} 1'
	);
});

test("deprecated usage is counted for cached documents only after variable coercion", async () => {
	const observed: string[] = [];
	let validationStarts = 0;
	const plugin: ApolloServerPlugin<TestContext> = {
		async requestDidStart() {
			return {
				async validationDidStart() {
					validationStarts += 1;
				},
				async executionDidStart(requestContext) {
					return createDeprecatedSchemaUsageExecutionListener<TestContext>({
						symbols: requestContext.contextValue.deprecatedSymbols ?? [],
						symbolOwners: requestContext.contextValue.deprecatedSymbolOwners ?? {},
						increment: (symbol) => observed.push(symbol),
					});
				},
			};
		},
	};
	const server = new ApolloServer<TestContext>({
		typeDefs: `
			type Query {
				legacy(required: Int!): String @deprecated(reason: "Use current")
			}
		`,
		resolvers: { Query: { legacy: () => "ok" } },
		plugins: [plugin],
	});
	servers.push(server);
	await server.start();

	const contextValue = { deprecatedSymbols: ["Query.legacy", "Query.legacy"] };
	const query = "{ legacy(required: 1) }";
	await server.executeOperation({ query }, { contextValue });
	await server.executeOperation({ query }, { contextValue });

	// The second operation skips validation through Apollo's document cache but
	// must still count one controlled symbol for that executable request.
	expect(validationStarts).toBe(1);
	expect(observed).toEqual(["Query.legacy", "Query.legacy"]);

	const invalidVariables = await server.executeOperation(
		{ query: "query Legacy($required: Int!) { legacy(required: $required) }" },
		{ contextValue }
	);
	expect(invalidVariables.body.kind).toBe("single");
	if (invalidVariables.body.kind === "single") {
		expect(invalidVariables.body.singleResult.errors?.[0]?.message).toContain(
			'Variable "$required" of required type "Int!" was not provided'
		);
	}
	// Variable coercion fails before the first resolver hook, so no usage is recorded.
	expect(observed).toEqual(["Query.legacy", "Query.legacy"]);
});

test("deprecated usage excludes nested fields skipped by a null parent", async () => {
	const observed: string[] = [];
	const plugin: ApolloServerPlugin<TestContext> = {
		async requestDidStart() {
			return {
				async executionDidStart(requestContext) {
					return createDeprecatedSchemaUsageExecutionListener<TestContext>({
						symbols: requestContext.contextValue.deprecatedSymbols ?? [],
						symbolOwners: requestContext.contextValue.deprecatedSymbolOwners ?? {},
						increment: (symbol) => observed.push(symbol),
					});
				},
			};
		},
	};
	const server = new ApolloServer<TestContext>({
		typeDefs: `
			type Query { parent: Child }
			type Child { legacy: String @deprecated(reason: "Use current") }
		`,
		resolvers: { Query: { parent: () => null } },
		plugins: [plugin],
	});
	servers.push(server);
	await server.start();

	await server.executeOperation(
		{ query: "{ parent { legacy } }" },
		{
			contextValue: {
				deprecatedSymbols: ["Child.legacy"],
				deprecatedSymbolOwners: { "Child.legacy": ["Child.legacy"] },
			},
		}
	);

	expect(observed).toEqual([]);
});
