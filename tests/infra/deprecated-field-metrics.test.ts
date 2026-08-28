import { afterEach, expect, test } from "bun:test";
import { ApolloServer, type ApolloServerPlugin } from "@apollo/server";
import { buildSchema } from "graphql";
import { createDeprecatedSchemaUsageExecutionListener } from "../../src/graphql/deprecation-observability";
import { validateGraphQLRequestLimits } from "../../src/graphql/limits";
import { metrics } from "../../src/infra/metrics";

type TestContext = {
	deprecatedSymbols?: readonly string[];
	deprecatedSymbolOwners?: Readonly<Record<string, readonly string[]>>;
	deprecatedSymbolGlobalSymbols?: readonly string[];
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
						globalSymbols: requestContext.contextValue.deprecatedSymbolGlobalSymbols,
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
						globalSymbols: requestContext.contextValue.deprecatedSymbolGlobalSymbols,
						increment: (symbol) => observed.push(symbol),
					});
				},
			};
		},
	};
	const typeDefs = `
		enum LegacyMode { OLD @deprecated(reason: "Use NEW") NEW }
		type Query { parent: Child }
		type Child { legacy(mode: LegacyMode): String }
	`;
	const server = new ApolloServer<TestContext>({
		typeDefs,
		resolvers: { Query: { parent: () => null } },
		plugins: [plugin],
	});
	servers.push(server);
	await server.start();

	const query = "query Usage($mode: LegacyMode!) { parent { legacy(mode: $mode) } }";
	const limits = validateGraphQLRequestLimits(
		{ query, variables: { mode: "OLD" } },
		buildSchema(typeDefs)
	);
	if (!limits.ok) throw new Error(limits.message);
	await server.executeOperation(
		{ query, variables: { mode: "OLD" } },
		{
			contextValue: {
				deprecatedSymbols: limits.deprecatedSymbols,
				deprecatedSymbolOwners: limits.deprecatedSymbolOwners,
				deprecatedSymbolGlobalSymbols: limits.deprecatedSymbolGlobalSymbols,
			},
		}
	);

	expect(observed).toEqual([]);
});

test("deprecated usage keeps field occurrences separate across response branches", async () => {
	const observed: string[] = [];
	const plugin: ApolloServerPlugin<TestContext> = {
		async requestDidStart() {
			return {
				async executionDidStart(requestContext) {
					return createDeprecatedSchemaUsageExecutionListener<TestContext>({
						symbols: requestContext.contextValue.deprecatedSymbols ?? [],
						symbolOwners: requestContext.contextValue.deprecatedSymbolOwners ?? {},
						globalSymbols: requestContext.contextValue.deprecatedSymbolGlobalSymbols,
						increment: (symbol) => observed.push(symbol),
					});
				},
			};
		},
	};
	const server = new ApolloServer<TestContext>({
		typeDefs: `
			enum LegacyMode { OLD @deprecated(reason: "Use NEW") NEW }
			type Query { missing: Wrapper, live: Wrapper }
			type Wrapper { value(mode: LegacyMode): String }
		`,
		resolvers: {
			Query: { missing: () => null, live: () => ({}) },
			Wrapper: { value: () => "ok" },
		},
		plugins: [plugin],
	});
	servers.push(server);
	await server.start();

	const query = "{ missing { value(mode: OLD) } live { value(mode: NEW) } }";
	const firstValueOffset = query.indexOf("value(mode: OLD)");
	await server.executeOperation(
		{ query },
		{
			contextValue: {
				deprecatedSymbols: ["LegacyMode.OLD"],
				deprecatedSymbolOwners: { [`field:${firstValueOffset}`]: ["LegacyMode.OLD"] },
			},
		}
	);

	expect(observed).toEqual([]);
});

test("deprecated usage keeps global symbols when an owned occurrence is unreachable", async () => {
	const observed: string[] = [];
	const plugin: ApolloServerPlugin<TestContext> = {
		async requestDidStart() {
			return {
				async executionDidStart(requestContext) {
					return createDeprecatedSchemaUsageExecutionListener<TestContext>({
						symbols: requestContext.contextValue.deprecatedSymbols ?? [],
						symbolOwners: requestContext.contextValue.deprecatedSymbolOwners ?? {},
						globalSymbols: requestContext.contextValue.deprecatedSymbolGlobalSymbols,
						increment: (symbol) => observed.push(symbol),
					});
				},
			};
		},
	};
	const server = new ApolloServer<TestContext>({
		typeDefs: `
			enum LegacyMode { OLD @deprecated(reason: "Use NEW") NEW }
			directive @legacy(mode: LegacyMode) on QUERY | FIELD
			type Query { parent: Child }
			type Child { value(mode: LegacyMode): String }
		`,
		resolvers: { Query: { parent: () => null } },
		plugins: [plugin],
	});
	servers.push(server);
	await server.start();

	const query = "query @legacy(mode: OLD) { parent { value(mode: OLD) } }";
	const firstValueOffset = query.indexOf("value(mode: OLD)");
	await server.executeOperation(
		{ query },
		{
			contextValue: {
				deprecatedSymbols: ["LegacyMode.OLD"],
				deprecatedSymbolGlobalSymbols: ["LegacyMode.OLD"],
				deprecatedSymbolOwners: { [`field:${firstValueOffset}`]: ["LegacyMode.OLD"] },
			},
		}
	);

	// The operation-level symbol is global and must be counted even though the
	// only owned field occurrence sits below a null parent.
	expect(observed).toEqual(["LegacyMode.OLD"]);
});
