import { afterEach, expect, test } from "bun:test";
import { ApolloServer, type ApolloServerPlugin } from "@apollo/server";
import { buildSchema } from "graphql";
import {
	createDeprecatedSchemaUsageExecutionListener,
	deprecationTypeOwnerSegment,
} from "../../src/graphql/deprecation-observability";
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

test("deprecated global usage is not committed when variable coercion fails", async () => {
	const observed: string[] = [];
	const plugin: ApolloServerPlugin<TestContext> = {
		async requestDidStart() {
			let executionHadErrors = false;
			let deferredCommit: (() => void) | undefined;
			return {
				async didEncounterErrors() {
					executionHadErrors = true;
				},
				async willSendResponse() {
					deferredCommit?.();
					deferredCommit = undefined;
				},
				async executionDidStart(requestContext) {
					return createDeprecatedSchemaUsageExecutionListener<TestContext>({
						symbols: requestContext.contextValue.deprecatedSymbols ?? [],
						globalSymbols: requestContext.contextValue.deprecatedSymbolGlobalSymbols,
						increment: (symbol) => observed.push(symbol),
						isExecutionSuccessful: () => !executionHadErrors,
						deferGlobalSymbols: true,
						registerDeferredGlobalCommit: (commit) => {
							deferredCommit = commit;
						},
					});
				},
			};
		},
	};
	const server = new ApolloServer<TestContext>({
		typeDefs: `type Query { current(required: Int!): String }`,
		resolvers: { Query: { current: () => "ok" } },
		plugins: [plugin],
	});
	servers.push(server);
	await server.start();
	const contextValue = {
		deprecatedSymbols: ["LegacyMode.OLD"],
		deprecatedSymbolGlobalSymbols: ["LegacyMode.OLD"],
	};
	await server.executeOperation(
		{ query: "query Usage($required: Int!) { current(required: $required) }" },
		{ contextValue }
	);
	expect(observed).toEqual([]);

	await server.executeOperation(
		{
			query: "query Usage($required: Int!) { current(required: $required) }",
			variables: { required: 1 },
		},
		{ contextValue }
	);
	expect(observed).toEqual(["LegacyMode.OLD"]);
});

test("deprecated global symbols commit for a successful fieldless execution", async () => {
	const observed: string[] = [];
	const listener = createDeprecatedSchemaUsageExecutionListener<TestContext>({
		symbols: ["LegacyMode.OLD"],
		globalSymbols: ["LegacyMode.OLD"],
		increment: (symbol) => observed.push(symbol),
	});

	await listener.executionDidEnd?.();

	expect(observed).toEqual(["LegacyMode.OLD"]);
});

test("deprecated telemetry keeps the actual typed owner beyond the variant cap", async () => {
	const observed: string[] = [];
	const listener = createDeprecatedSchemaUsageExecutionListener<TestContext>({
		symbols: ["LegacyMode.OLD"],
		symbolOwners: {
			["path:" +
			Array.from(
				{ length: 9 },
				(_, index) => `${deprecationTypeOwnerSegment(`Type${index}`)}.field${index}`
			).join(".")]: ["LegacyMode.OLD"],
		},
		increment: (symbol) => observed.push(symbol),
	});
	const fields = Array.from({ length: 9 }, (_, index) => `field${index}`);
	const pathFor = (segments: readonly string[]): unknown => {
		let path: unknown;
		for (let index = 0; index < segments.length; index += 1) {
			path = { key: segments[index], prev: path };
		}
		return path;
	};
	for (let length = 1; length <= fields.length; length += 1) {
		listener.willResolveField?.({
			info: {
				path: pathFor(fields.slice(0, length)),
				parentType: { name: `Type${length - 1}` },
				fieldName: fields[length - 1],
				fieldNodes: [],
			},
		} as never);
	}

	await listener.executionDidEnd?.();

	expect(observed).toEqual(["LegacyMode.OLD"]);
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

test("deprecated fragment-definition values are not committed when their parent is null", async () => {
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
		directive @legacy(mode: LegacyMode) on FRAGMENT_DEFINITION
		type Query { parent: Child }
		type Child { value: String }
	`;
	const server = new ApolloServer<TestContext>({
		typeDefs,
		resolvers: { Query: { parent: () => null } },
		plugins: [plugin],
	});
	servers.push(server);
	await server.start();

	const query = `
		query Usage($mode: LegacyMode!) {
			parent { ...ChildFields }
		}
		fragment ChildFields on Child @legacy(mode: $mode) { value }
	`;
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

test("deprecated inline-fragment directives follow the runtime type branch", async () => {
	const observed: string[] = [];
	const typeDefs = `
		enum LegacyMode { OLD @deprecated(reason: "Use NEW") NEW }
		directive @legacy(mode: LegacyMode) on INLINE_FRAGMENT | FRAGMENT_SPREAD
		interface Node { id: ID! }
		type Cat implements Node { id: ID!, catValue: String }
		type Dog implements Node { id: ID!, dogValue: String }
		type Query { node: Node }
	`;
	const server = new ApolloServer<TestContext>({
		typeDefs,
		resolvers: {
			Query: { node: () => ({ __typename: "Cat", id: "cat" }) },
			Node: { __resolveType: (value: { __typename: string }) => value.__typename },
		},
		plugins: [
			{
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
			},
		],
	});
	servers.push(server);
	await server.start();

	const query = `
		query Usage($mode: LegacyMode!) {
			node { ... on Dog @legacy(mode: $mode) { dogValue } }
		}
	`;
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

	// The Cat result never executes the Dog inline-fragment field, so the
	// branch-owned directive usage must not be recorded.
	expect(observed).toEqual([]);
});

test("deprecated fragment-spread directives follow their response-path occurrence", async () => {
	const observed: string[] = [];
	const typeDefs = `
		enum LegacyMode {
			MISSING @deprecated(reason: "Use NEW")
			LIVE @deprecated(reason: "Use NEW")
			NEW
		}
		directive @legacy(mode: LegacyMode) on FRAGMENT_SPREAD
		type Query { missing: Wrapper, live: Wrapper }
		type Wrapper { value: String }
	`;
	const server = new ApolloServer<TestContext>({
		typeDefs,
		resolvers: {
			Query: { missing: () => null, live: () => ({}) },
			Wrapper: { value: () => "ok" },
		},
		plugins: [
			{
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
			},
		],
	});
	servers.push(server);
	await server.start();

	const query = `
		query {
			missing { ...Fields @legacy(mode: MISSING) }
			live { ...Fields @legacy(mode: LIVE) }
		}
		fragment Fields on Wrapper { value }
	`;
	const limits = validateGraphQLRequestLimits({ query }, buildSchema(typeDefs));
	if (!limits.ok) throw new Error(limits.message);
	await server.executeOperation(
		{ query },
		{
			contextValue: {
				deprecatedSymbols: limits.deprecatedSymbols,
				deprecatedSymbolOwners: limits.deprecatedSymbolOwners,
				deprecatedSymbolGlobalSymbols: limits.deprecatedSymbolGlobalSymbols,
			},
		}
	);
	expect(observed).toEqual(["LegacyMode.LIVE"]);
});

test("deprecated nested fragment directives are collected for every fragment occurrence", async () => {
	const observed: string[] = [];
	const typeDefs = `
		enum LegacyMode { LIVE @deprecated(reason: "Use NEW") NEW }
		directive @legacy(mode: LegacyMode) on FRAGMENT_SPREAD
		type Query { missing: Wrapper, live: Wrapper }
		type Wrapper { child: Wrapper, value: String }
	`;
	const server = new ApolloServer<TestContext>({
		typeDefs,
		resolvers: {
			Query: { missing: () => null, live: () => ({ child: {} }) },
			Wrapper: { child: (value: { child?: unknown }) => value.child ?? null, value: () => "ok" },
		},
		plugins: [
			{
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
			},
		],
	});
	servers.push(server);
	await server.start();

	const query = `
		query {
			missing { ...Outer }
			live { ...Outer }
		}
		fragment Outer on Wrapper { child { ...Inner @legacy(mode: LIVE) } }
		fragment Inner on Wrapper { value }
	`;
	const limits = validateGraphQLRequestLimits({ query }, buildSchema(typeDefs));
	if (!limits.ok) throw new Error(limits.message);
	await server.executeOperation(
		{ query },
		{
			contextValue: {
				deprecatedSymbols: limits.deprecatedSymbols,
				deprecatedSymbolOwners: limits.deprecatedSymbolOwners,
				deprecatedSymbolGlobalSymbols: limits.deprecatedSymbolGlobalSymbols,
			},
		}
	);

	expect(observed).toEqual(["LegacyMode.LIVE"]);
});

test("deprecated nested directives retain enclosing named-fragment conditions", async () => {
	const observed: string[] = [];
	const typeDefs = `
		enum LegacyMode {
			CAT @deprecated(reason: "Use NEW")
			DOG @deprecated(reason: "Use NEW")
			NEW
		}
		directive @legacy(mode: LegacyMode) on FRAGMENT_SPREAD
		interface Node { id: ID!, child: Node, value: String }
		type Cat implements Node { id: ID!, child: Node, value: String }
		type Dog implements Node { id: ID!, child: Node, value: String }
		type Query { node: Node }
	`;
	const server = new ApolloServer<TestContext>({
		typeDefs,
		resolvers: {
			Query: {
				node: () => ({
					__typename: "Dog",
					id: "root",
					child: { __typename: "Dog", id: "child" },
				}),
			},
			Node: { __resolveType: (value: { __typename: string }) => value.__typename },
			Dog: {
				child: (value: { child?: unknown }) => value.child ?? null,
				value: () => "ok",
			},
		},
		plugins: [
			{
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
			},
		],
	});
	servers.push(server);
	await server.start();

	const query = `
		query {
			node {
				...CatBranch
				... on Dog {
					child { ...FieldsDog @legacy(mode: DOG) }
				}
			}
		}
		fragment CatBranch on Cat {
			child { ...FieldsCat @legacy(mode: CAT) }
		}
		fragment FieldsCat on Node { value }
		fragment FieldsDog on Node { value }
	`;
	const limits = validateGraphQLRequestLimits({ query }, buildSchema(typeDefs));
	if (!limits.ok) throw new Error(limits.message);
	await server.executeOperation(
		{ query },
		{
			contextValue: {
				deprecatedSymbols: limits.deprecatedSymbols,
				deprecatedSymbolOwners: limits.deprecatedSymbolOwners,
				deprecatedSymbolGlobalSymbols: limits.deprecatedSymbolGlobalSymbols,
			},
		}
	);

	// The root is Dog, so CatBranch is skipped even though its nested spread
	// resolves the same response path as the executed Dog branch.
	expect(observed).toEqual(["LegacyMode.DOG"]);
});

test("deprecated fragment-spread directives keep conditional runtime branches separate", async () => {
	const observed: string[] = [];
	const typeDefs = `
		enum LegacyMode {
			CAT @deprecated(reason: "Use NEW")
			DOG @deprecated(reason: "Use NEW")
			NEW
		}
		directive @legacy(mode: LegacyMode) on FRAGMENT_SPREAD
		interface Node { id: ID!, value: String }
		type Cat implements Node { id: ID!, value: String }
		type Dog implements Node { id: ID!, value: String }
		type Query { nodes: [Node!]! }
	`;
	const server = new ApolloServer<TestContext>({
		typeDefs,
		resolvers: {
			Query: { nodes: () => [{ __typename: "Cat", id: "cat", value: "ok" }] },
			Node: { __resolveType: (value: { __typename: string }) => value.__typename },
		},
		plugins: [
			{
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
			},
		],
	});
	servers.push(server);
	await server.start();

	const query = `
		query {
			nodes {
				... on Cat { ...Fields @legacy(mode: CAT) }
				... on Dog { ...Fields @legacy(mode: DOG) }
			}
		}
		fragment Fields on Node { value }
	`;
	const limits = validateGraphQLRequestLimits({ query }, buildSchema(typeDefs));
	if (!limits.ok) throw new Error(limits.message);

	await server.executeOperation(
		{ query },
		{
			contextValue: {
				deprecatedSymbols: limits.deprecatedSymbols,
				deprecatedSymbolOwners: limits.deprecatedSymbolOwners,
				deprecatedSymbolGlobalSymbols: limits.deprecatedSymbolGlobalSymbols,
			},
		}
	);
	// Only the Cat item executes, so the Dog branch's same response path must not
	// cause its directive value to be counted.
	expect(observed).toEqual(["LegacyMode.CAT"]);
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
