import { describe, expect, it } from "bun:test";
import { buildSchema, getIntrospectionQuery, parse, visit } from "graphql";
import { validateGraphQLRequestLimits } from "../../src/graphql/limits";
import { schema } from "../../src/graphql/schema";

describe("GraphQL request limits", () => {
	it("rejects invalid transport payloads before query cost analysis", () => {
		expect(validateGraphQLRequestLimits([])).toEqual({
			ok: false,
			code: "BATCHING_DISABLED",
			message: "GraphQL request batching is disabled",
		});
		expect(validateGraphQLRequestLimits({})).toEqual({
			ok: false,
			code: "INVALID_GRAPHQL_REQUEST",
			message: "GraphQL request body must contain a query string",
		});
	});

	it("accepts an ordinary query", () => {
		const result = validateGraphQLRequestLimits({
			query: "query { events { id name } }",
		});
		expect(result).toMatchObject({ ok: true, rateLimitCostUnits: 1, rootFields: ["events"] });
	});

	it("does not retain deprecated Live Points fields after the V2 cutover", () => {
		const result = validateGraphQLRequestLimits(
			{
				query: `
					query Usage {
						calcLivePointsByEntry(eventId: 1, entryId: 1) {
							score { eventPoints }
						}
					}
				`,
			},
			schema
		);
		expect(result).toMatchObject({
			ok: true,
			deprecatedSymbols: [],
		});
		const owners = (result as { deprecatedSymbolOwners?: Record<string, string[]> })
			.deprecatedSymbolOwners;
		expect(owners).toEqual({});
	});

	it("does not report deprecated selections excluded by skip/include directives", () => {
		const directiveSchema = buildSchema(`
			input LegacyInput {
				old: String @deprecated(reason: "Use current")
			}
			type Query {
				current: String
				legacy(
					oldArg: String @deprecated(reason: "Use currentArg")
					input: LegacyInput
				): String
					@deprecated(reason: "Use current")
			}
		`);
		const result = validateGraphQLRequestLimits(
			{
				query: `
					query Usage($showLegacy: Boolean! = false, $input: LegacyInput!) {
						current
						legacy(oldArg: "ignored", input: $input) @skip(if: true)
						legacy @include(if: $showLegacy)
						...SkippedLegacy @skip(if: true)
						... on Query @include(if: false) { legacy }
					}
					fragment SkippedLegacy on Query { legacy }
				`,
				variables: { input: { old: "ignored" } },
			},
			directiveSchema
		);
		expect(result).toMatchObject({ ok: true, deprecatedSymbols: [] });
	});

	it("reports deprecated selections from executable directive branches", () => {
		const directiveSchema = buildSchema(`
			type Query {
				legacy: String @deprecated(reason: "Use current")
			}
		`);
		const result = validateGraphQLRequestLimits(
			{
				query: `
					query Usage($showLegacy: Boolean!) {
						...ActiveLegacy @include(if: $showLegacy)
					}
					fragment ActiveLegacy on Query { legacy }
				`,
				variables: { showLegacy: true },
			},
			directiveSchema
		);
		expect(result).toMatchObject({ ok: true, deprecatedSymbols: ["Query.legacy"] });
	});

	it("bounds deprecated telemetry traversal for repeated fragment DAGs", () => {
		const fragmentCount = 24;
		const fragments = Array.from({ length: fragmentCount }, (_, index) =>
			index === 0
				? "fragment F0 on Query { legacy }"
				: `fragment F${index} on Query { ...F${index - 1} ...F${index - 1} }`
		).join("\n");
		const deprecatedSchema = buildSchema(`
				type Query {
					legacy: String @deprecated(reason: "Use current")
				}
			`);
		const result = validateGraphQLRequestLimits(
			{ query: `query { ...F${fragmentCount - 1} }\n${fragments}` },
			deprecatedSchema
		);

		expect(result).toEqual({
			ok: false,
			code: "QUERY_TOO_COMPLEX",
			message: "GraphQL document exceeds 200 AST nodes",
		});
	}, 1_000);

	it("reports deprecated arguments and variable-backed input and enum symbols", () => {
		const deprecatedKindsSchema = buildSchema(`
			enum LegacyMode {
				OLD @deprecated(reason: "Use NEW")
				NEW
			}
			input LegacyInput {
				old: String @deprecated(reason: "Use current")
				current: String
			}
			type Query {
				example(
					oldArg: String @deprecated(reason: "Use currentArg")
					input: LegacyInput
					mode: LegacyMode
				): String
			}
		`);
		const result = validateGraphQLRequestLimits(
			{
				query: `
					query Usage($input: LegacyInput!, $mode: LegacyMode!) {
						example(oldArg: "legacy", input: $input, mode: $mode)
					}
				`,
				variables: { input: { old: "legacy" }, mode: "OLD" },
			},
			deprecatedKindsSchema
		);
		expect(result).toMatchObject({
			ok: true,
			deprecatedSymbols: ["LegacyInput.old", "LegacyMode.OLD", "Query.example(oldArg:)"],
		});
	});

	it("does not report a deprecated argument backed by an omitted optional variable", () => {
		const deprecatedArgumentSchema = buildSchema(`
			type Query {
				example(oldArg: String @deprecated(reason: "Use current")): String
			}
		`);
		const result = validateGraphQLRequestLimits(
			{
				query: "query Usage($old: String) { example(oldArg: $old) }",
				variables: {},
			},
			deprecatedArgumentSchema
		);
		expect(result).toMatchObject({ ok: true, deprecatedSymbols: [] });
	});

	it("keeps global deprecated symbols separate from field-owned occurrences", () => {
		const deprecatedKindsSchema = buildSchema(`
			enum LegacyMode {
				OLD @deprecated(reason: "Use NEW")
				NEW
			}
			directive @legacy(mode: LegacyMode) on QUERY | FIELD
			type Query { parent: Child }
			type Child { value(mode: LegacyMode): String }
		`);
		const query = "query @legacy(mode: OLD) { parent { value(mode: OLD) } }";
		const result = validateGraphQLRequestLimits({ query }, deprecatedKindsSchema);

		expect(result).toMatchObject({
			ok: true,
			deprecatedSymbols: ["LegacyMode.OLD"],
			deprecatedSymbolGlobalSymbols: ["LegacyMode.OLD"],
		});
		if (!result.ok) throw new Error(result.message);
		const valueOffset = query.indexOf("value(mode: OLD)");
		expect(result.deprecatedSymbolOwners[`field:${valueOffset}`]).toEqual(["LegacyMode.OLD"]);
	});

	it("reports deprecated arguments on executable directives", () => {
		const directiveSchema = buildSchema(`
			directive @legacy(note: String @deprecated(reason: "Use current")) on FIELD
			type Query { current: String }
		`);
		const result = validateGraphQLRequestLimits(
			{ query: `{ current @legacy(note: "old") }` },
			directiveSchema
		);
		expect(result).toMatchObject({ ok: true, deprecatedSymbols: ["@legacy(note:)"] });
	});

	it("reports deprecated arguments on variable-definition directives", () => {
		const directiveSchema = buildSchema(`
			directive @legacy(note: String @deprecated(reason: "Use current"))
				on VARIABLE_DEFINITION | FIELD
			type Query { current: String }
		`);
		const result = validateGraphQLRequestLimits(
			{ query: 'query Usage($id: ID! @legacy(note: "old")) { current }' },
			directiveSchema
		);
		expect(result).toMatchObject({ ok: true, deprecatedSymbols: ["@legacy(note:)"] });
	});

	it("reports deprecated enum and input values passed through executable directives", () => {
		const directiveSchema = buildSchema(`
			enum LegacyMode {
				OLD @deprecated(reason: "Use NEW")
				NEW
			}
			input LegacyInput {
				old: String @deprecated(reason: "Use current")
				current: String
			}
			directive @legacy(
				mode: LegacyMode @deprecated(reason: "Use currentMode")
				input: LegacyInput
			) on FIELD | INLINE_FRAGMENT | FRAGMENT_SPREAD
			type Query { current: String }
		`);
		const result = validateGraphQLRequestLimits(
			{
				query: `
					query Usage($mode: LegacyMode!, $input: LegacyInput!) {
						current @legacy(mode: $mode, input: $input)
						...Active @legacy(mode: $mode, input: $input)
						... on Query @legacy(mode: $mode, input: $input) { current }
					}
					fragment Active on Query { current }
				`,
				variables: { mode: "OLD", input: { old: "legacy" } },
			},
			directiveSchema
		);
		expect(result).toMatchObject({
			ok: true,
			deprecatedSymbols: ["@legacy(mode:)", "LegacyInput.old", "LegacyMode.OLD"],
		});
	});

	it("accounts for only the effective deprecated variable value", () => {
		const deprecatedKindsSchema = buildSchema(`
			enum LegacyMode {
				OLD @deprecated(reason: "Use NEW")
				NEW
			}
			type Query { example(mode: LegacyMode): String }
		`);
		const query = `query Usage($mode: LegacyMode = OLD) { example(mode: $mode) }`;

		expect(
			validateGraphQLRequestLimits({ query, variables: { mode: "NEW" } }, deprecatedKindsSchema)
		).toMatchObject({ ok: true, deprecatedSymbols: [] });
		expect(validateGraphQLRequestLimits({ query }, deprecatedKindsSchema)).toMatchObject({
			ok: true,
			deprecatedSymbols: ["LegacyMode.OLD"],
		});
	});

	it("reports deprecated values supplied by omitted schema defaults", () => {
		const defaultsSchema = buildSchema(`
			enum LegacyMode {
				OLD @deprecated(reason: "Use NEW")
				NEW
			}
			input LegacyInput {
				mode: LegacyMode = OLD
			}
			directive @legacy(mode: LegacyMode = OLD, input: LegacyInput = {}) on FIELD
			type Query {
				example(mode: LegacyMode = OLD, input: LegacyInput = {}): String
			}
		`);
		const result = validateGraphQLRequestLimits(
			{ query: "query { example @legacy }" },
			defaultsSchema
		);
		expect(result).toMatchObject({
			ok: true,
			deprecatedSymbols: ["LegacyMode.OLD"],
		});
	});

	it("applies field argument defaults when an optional variable is omitted", () => {
		const defaultsSchema = buildSchema(`
			enum LegacyMode {
				OLD @deprecated(reason: "Use NEW")
				NEW
			}
			type Query { example(mode: LegacyMode = OLD): String }
		`);
		const query = "query Usage($mode: LegacyMode) { example(mode: $mode) }";
		expect(validateGraphQLRequestLimits({ query }, defaultsSchema)).toMatchObject({
			ok: true,
			deprecatedSymbols: ["LegacyMode.OLD"],
		});
		expect(
			validateGraphQLRequestLimits({ query, variables: { mode: "NEW" } }, defaultsSchema)
		).toMatchObject({ ok: true, deprecatedSymbols: [] });
		expect(
			validateGraphQLRequestLimits({ query, variables: { mode: null } }, defaultsSchema)
		).toMatchObject({ ok: true, deprecatedSymbols: [] });
	});

	it("keeps variable-backed deprecated values owned by their field occurrence", () => {
		const deprecatedKindsSchema = buildSchema(`
			enum LegacyMode {
				OLD @deprecated(reason: "Use NEW")
				NEW
			}
			type Query { parent: Child }
			type Child { value(mode: LegacyMode): String }
		`);
		const query = "query Usage($mode: LegacyMode!) { parent { value(mode: $mode) } }";
		const result = validateGraphQLRequestLimits(
			{ query, variables: { mode: "OLD" } },
			deprecatedKindsSchema
		);

		expect(result).toMatchObject({
			ok: true,
			deprecatedSymbols: ["LegacyMode.OLD"],
			deprecatedSymbolGlobalSymbols: [],
		});
		if (!result.ok) throw new Error(result.message);
		const valueOffset = query.indexOf("value(mode: $mode)");
		expect(result.deprecatedSymbolOwners[`field:${valueOffset}`]).toEqual(["LegacyMode.OLD"]);
	});

	it("keeps fragment-definition directive values owned by active field occurrences", () => {
		const deprecatedKindsSchema = buildSchema(`
			enum LegacyMode {
				OLD @deprecated(reason: "Use NEW")
				NEW
			}
			directive @legacy(
				mode: LegacyMode
				note: String @deprecated(reason: "Use current")
			) on FRAGMENT_DEFINITION
			type Query { parent: Child }
			type Child { value: String }
		`);
		const query = `
			query Usage($mode: LegacyMode!) {
				parent { ...ChildFields }
			}
			fragment ChildFields on Child @legacy(mode: $mode, note: "old") { value }
		`;
		const result = validateGraphQLRequestLimits(
			{ query, variables: { mode: "OLD" } },
			deprecatedKindsSchema
		);

		expect(result).toMatchObject({
			ok: true,
			deprecatedSymbols: ["@legacy(note:)", "LegacyMode.OLD"],
			deprecatedSymbolGlobalSymbols: [],
		});
		if (!result.ok) throw new Error(result.message);
		expect(result.deprecatedSymbolOwners["path:parent.__type:Child.value"]).toEqual([
			"@legacy(note:)",
			"LegacyMode.OLD",
		]);
	});

	it("keys repeated fragment-spread directive values by response occurrence", () => {
		const deprecatedKindsSchema = buildSchema(`
			enum LegacyMode {
				LEFT @deprecated(reason: "Use NEW")
				RIGHT @deprecated(reason: "Use NEW")
				NEW
			}
			directive @legacy(mode: LegacyMode) on FRAGMENT_SPREAD
			type Query { left: Wrapper, right: Wrapper }
			type Wrapper { value: String }
		`);
		const query = `
			query Usage {
				left { ...Fields @legacy(mode: LEFT) }
				right { ...Fields @legacy(mode: RIGHT) }
			}
			fragment Fields on Wrapper { value }
		`;
		const result = validateGraphQLRequestLimits({ query }, deprecatedKindsSchema);

		expect(result).toMatchObject({
			ok: true,
			deprecatedSymbols: ["LegacyMode.LEFT", "LegacyMode.RIGHT"],
			deprecatedSymbolGlobalSymbols: [],
		});
		if (!result.ok) throw new Error(result.message);
		expect(result.deprecatedSymbolOwners["path:left.__type:Wrapper.value"]).toEqual([
			"LegacyMode.LEFT",
		]);
		expect(result.deprecatedSymbolOwners["path:right.__type:Wrapper.value"]).toEqual([
			"LegacyMode.RIGHT",
		]);
	});

	it("disambiguates fragment-spread directives across conditional type branches", () => {
		const deprecatedKindsSchema = buildSchema(`
			enum LegacyMode {
				CAT @deprecated(reason: "Use NEW")
				DOG @deprecated(reason: "Use NEW")
				NEW
			}
			directive @legacy(mode: LegacyMode) on FRAGMENT_SPREAD
			interface Node { id: ID!, value: String }
			type Cat implements Node { id: ID!, value: String }
			type Dog implements Node { id: ID!, value: String }
			type Query { node: Node }
		`);
		const query = `
			query Usage {
				node {
					... on Cat { ...Fields @legacy(mode: CAT) }
					... on Dog { ...Fields @legacy(mode: DOG) }
				}
			}
			fragment Fields on Node { value }
		`;
		const result = validateGraphQLRequestLimits({ query }, deprecatedKindsSchema);

		expect(result).toMatchObject({
			ok: true,
			deprecatedSymbols: ["LegacyMode.CAT", "LegacyMode.DOG"],
			deprecatedSymbolGlobalSymbols: [],
		});
		if (!result.ok) throw new Error(result.message);
		expect(result.deprecatedSymbolOwners["path:node.__type:Cat.value"]).toEqual(["LegacyMode.CAT"]);
		expect(result.deprecatedSymbolOwners["path:node.__type:Dog.value"]).toEqual(["LegacyMode.DOG"]);
	});

	it("includes named fragment type conditions in occurrence owners", () => {
		const deprecatedKindsSchema = buildSchema(`
			enum LegacyMode {
				CAT @deprecated(reason: "Use NEW")
				DOG @deprecated(reason: "Use NEW")
				NEW
			}
			directive @legacy(mode: LegacyMode) on FRAGMENT_SPREAD
			interface Node { id: ID!, value: String }
			type Cat implements Node { id: ID!, value: String }
			type Dog implements Node { id: ID!, value: String }
			type Query { node: Node }
		`);
		const query = `
			query Usage {
				node { ...CatFields @legacy(mode: CAT) ...DogFields @legacy(mode: DOG) }
			}
			fragment CatFields on Cat { value }
			fragment DogFields on Dog { value }
		`;
		const result = validateGraphQLRequestLimits({ query }, deprecatedKindsSchema);

		expect(result).toMatchObject({
			ok: true,
			deprecatedSymbols: ["LegacyMode.CAT", "LegacyMode.DOG"],
			deprecatedSymbolGlobalSymbols: [],
		});
		if (!result.ok) throw new Error(result.message);
		expect(result.deprecatedSymbolOwners["path:node.__type:Cat.value"]).toEqual(["LegacyMode.CAT"]);
		expect(result.deprecatedSymbolOwners["path:node.__type:Dog.value"]).toEqual(["LegacyMode.DOG"]);
	});

	it("does not retain shared field owners for conditional inline directives", () => {
		const deprecatedKindsSchema = buildSchema(`
			enum LegacyMode {
				CAT @deprecated(reason: "Use NEW")
				DOG @deprecated(reason: "Use NEW")
				NEW
			}
			directive @legacy(mode: LegacyMode) on INLINE_FRAGMENT
			interface Node { id: ID!, value: String }
			type Cat implements Node { id: ID!, value: String }
			type Dog implements Node { id: ID!, value: String }
			type Query { node: Node }
		`);
		const query = `
			query Usage {
				node {
					... on Cat @legacy(mode: CAT) { ...Fields }
					... on Dog @legacy(mode: DOG) { ...Fields }
				}
			}
			fragment Fields on Node { value }
		`;
		const result = validateGraphQLRequestLimits({ query }, deprecatedKindsSchema);

		expect(result).toMatchObject({
			ok: true,
			deprecatedSymbols: ["LegacyMode.CAT", "LegacyMode.DOG"],
			deprecatedSymbolGlobalSymbols: [],
		});
		if (!result.ok) throw new Error(result.message);
		expect(result.deprecatedSymbolOwners["path:node.__type:Cat.value"]).toEqual(["LegacyMode.CAT"]);
		expect(result.deprecatedSymbolOwners["path:node.__type:Dog.value"]).toEqual(["LegacyMode.DOG"]);
	});

	it("keeps inline fragment directive values owned by fields in its type branch", () => {
		const deprecatedKindsSchema = buildSchema(`
			enum LegacyMode {
				OLD @deprecated(reason: "Use NEW")
				NEW
			}
			directive @legacy(mode: LegacyMode) on INLINE_FRAGMENT | FRAGMENT_SPREAD
			interface Node { id: ID! }
			type Cat implements Node { id: ID!, catValue: String }
			type Dog implements Node { id: ID!, dogValue: String }
			type Query { node: Node }
		`);
		const query = `
			query Usage($mode: LegacyMode!) {
				node {
					... on Dog @legacy(mode: $mode) { dogValue }
				}
			}
		`;
		const result = validateGraphQLRequestLimits(
			{ query, variables: { mode: "OLD" } },
			deprecatedKindsSchema
		);

		expect(result).toMatchObject({
			ok: true,
			deprecatedSymbols: ["LegacyMode.OLD"],
			deprecatedSymbolGlobalSymbols: [],
		});
		if (!result.ok) throw new Error(result.message);
		const nodeOffset = query.indexOf("node {");
		expect(result.deprecatedSymbolOwners["path:node.__type:Dog.dogValue"]).toEqual([
			"LegacyMode.OLD",
		]);
		expect(result.deprecatedSymbolOwners[`field:${nodeOffset}`]).toBeUndefined();
	});

	it("does not report deprecated input fields whose optional variable is omitted", () => {
		const deprecatedKindsSchema = buildSchema(`
			input LegacyInput {
				old: String @deprecated(reason: "Use current")
				current: String
			}
			type Query { example(input: LegacyInput): String }
		`);
		const query = "query Usage($value: String) { example(input: { old: $value }) }";

		expect(validateGraphQLRequestLimits({ query }, deprecatedKindsSchema)).toMatchObject({
			ok: true,
			deprecatedSymbols: [],
		});
		expect(
			validateGraphQLRequestLimits({ query, variables: { value: "legacy" } }, deprecatedKindsSchema)
		).toMatchObject({
			ok: true,
			deprecatedSymbols: ["LegacyInput.old"],
		});
	});

	it("keeps live price-change roots public and bounded", () => {
		for (const query of [
			"query { priceChangeLiveCursor { revision state } }",
			'query { priceChangeLiveBoard(revision: "abcdef0123456789") { revision state } }',
		]) {
			expect(validateGraphQLRequestLimits({ query }, schema)).toMatchObject({
				ok: true,
				rootFields: [query.includes("Cursor") ? "priceChangeLiveCursor" : "priceChangeLiveBoard"],
			});
		}
	});

	it("charges the metadata-only live cursor at its one-unit floor", () => {
		const result = validateGraphQLRequestLimits(
			{ query: "query { priceChangeLiveCursor { revision state } }" },
			schema
		);
		expect(result).toMatchObject({ ok: true, rateLimitCostUnits: 1 });
	});

	it("charges every bounded public root at its effective five-unit floor", () => {
		for (const [query, rootField] of [
			["query { marketSnapshotContext { revision } }", "marketSnapshotContext"],
			["query { teams { id } }", "teams"],
			["query { miniProgramNotice }", "miniProgramNotice"],
		] as const) {
			expect(validateGraphQLRequestLimits({ query }, schema)).toMatchObject({
				ok: true,
				rootFields: [rootField],
				rateLimitCostUnits: 5,
			});
		}
	});

	it("preserves bounded floors when a bounded root is mixed with ordinary roots", () => {
		const result = validateGraphQLRequestLimits({ query: "query { teams { id } _empty }" }, schema);
		expect(result).toMatchObject({ ok: true, rootFields: ["teams", "_empty"] });
		if (!result.ok) throw new Error(result.message);
		// `teams` is registered at 2 but its bounded effective floor is 5;
		// `_empty` contributes its normal one-unit root floor.
		expect(result.rateLimitCostUnits).toBeGreaterThanOrEqual(6);
	});

	it("identifies a fixture-only read before resolver execution", () => {
		const result = validateGraphQLRequestLimits({
			query: "query CoreEventFixtureSchedule { eventFixtures(eventId: 1) { id } }",
		});
		expect(result).toMatchObject({ ok: true, rootFields: ["eventFixtures"] });
	});

	it("allows the bounded tournament detail desk AST projection", () => {
		const fields = Array.from({ length: 100 }, () => "kind").join(" ");
		const desk = validateGraphQLRequestLimits({
			query: `query { tournamentDetailDesk(tournamentId: 1, entryId: 1) { ${fields} } }`,
		});
		expect(desk).toMatchObject({ ok: true, rootFields: ["tournamentDetailDesk"] });

		const ordinary = validateGraphQLRequestLimits({
			query: `query { events { ${fields} } }`,
		});
		expect(ordinary).toEqual({
			ok: false,
			code: "QUERY_TOO_COMPLEX",
			message: "GraphQL document exceeds 200 AST nodes",
		});
	});

	it("allows the bounded tournament review V2 projections", () => {
		const fields = Array.from({ length: 100 }, () => "state").join(" ");
		for (const query of [
			`query { myTournamentGameweekReview(tournamentId: 1, eventId: 1) { ${fields} } }`,
			`query { myTournamentSeasonReview(tournamentId: 1, throughEventId: 1) { ${fields} } }`,
		]) {
			expect(validateGraphQLRequestLimits({ query })).toMatchObject({ ok: true });
		}

		const ordinary = validateGraphQLRequestLimits({
			query: `query { events { ${fields} } }`,
		});
		expect(ordinary).toEqual({
			ok: false,
			code: "QUERY_TOO_COMPLEX",
			message: "GraphQL document exceeds 200 AST nodes",
		});
	});

	it("only grants the tournament review AST cap to a sole effective root", () => {
		const fields = Array.from({ length: 100 }, () => "state").join(" ");
		const mixed = validateGraphQLRequestLimits({
			query: `query { myTournamentSeasonReview(tournamentId: 1, throughEventId: 1) { ${fields} } events { id } }`,
		});
		expect(mixed).toEqual({
			ok: false,
			code: "QUERY_TOO_COMPLEX",
			message: "GraphQL document exceeds 200 AST nodes",
		});
	});

	it("only grants the desk AST cap to the sole effective root", () => {
		const fields = Array.from({ length: 220 }, () => "kind").join(" ");
		const mixed = validateGraphQLRequestLimits({
			query: `query { tournamentDetailDesk(tournamentId: 1, entryId: 1) { ${fields} } events { id } }`,
		});
		expect(mixed).toEqual({
			ok: false,
			code: "QUERY_TOO_COMPLEX",
			message: "GraphQL document exceeds 200 AST nodes",
		});
	});

	it("recognizes a desk root selected through a fragment", () => {
		const fields = Array.from({ length: 100 }, () => "kind").join(" ");
		const result = validateGraphQLRequestLimits({
			query: `query { ...DeskRoot } fragment DeskRoot on Query { tournamentDetailDesk(tournamentId: 1, entryId: 1) { ${fields} } }`,
		});
		expect(result).toMatchObject({ ok: true, rootFields: ["tournamentDetailDesk"] });
	});

	it("keeps unrelated operations under the general AST cap", () => {
		const fields = Array.from({ length: 100 }, () => "id").join(" ");
		const result = validateGraphQLRequestLimits({
			operationName: "Desk",
			query: `query Desk { tournamentDetailDesk(tournamentId: 1, entryId: 1) { kind } } query Other { events { ${fields} } }`,
		});
		expect(result).toEqual({
			ok: false,
			code: "QUERY_TOO_COMPLEX",
			message: "GraphQL document exceeds 200 AST nodes",
		});
	});

	it("merges repeated unaliased desk selections but rejects aliases", () => {
		const fields = Array.from({ length: 60 }, () => "kind").join(" ");
		const merged = validateGraphQLRequestLimits({
			query: `query { tournamentDetailDesk(tournamentId: 1, entryId: 1) { ${fields} } tournamentDetailDesk(tournamentId: 1, entryId: 1) { ${fields} } }`,
		});
		expect(merged).toMatchObject({
			ok: true,
			rootFields: ["tournamentDetailDesk", "tournamentDetailDesk"],
		});

		const aliased = validateGraphQLRequestLimits({
			query: `query { first: tournamentDetailDesk(tournamentId: 1, entryId: 1) { ${fields} } second: tournamentDetailDesk(tournamentId: 1, entryId: 1) { ${fields} } }`,
		});
		expect(aliased).toEqual({
			ok: false,
			code: "QUERY_TOO_COMPLEX",
			message: "GraphQL document exceeds 200 AST nodes",
		});
	});

	it("charges one bounded gameweek desk root instead of separate live roots", () => {
		const result = validateGraphQLRequestLimits({
			query: "query { gameweekDesk(eventId: 1) { eventId dreamTeam { id } hauls { id } } }",
		});
		expect(result).toMatchObject({ ok: true, rootFields: ["gameweekDesk"], rateLimitCostUnits: 5 });
	});

	it("charges the compact Home public, market, and personal roots", () => {
		expect(
			validateGraphQLRequestLimits({ query: "query { homePersonalDesk { state } }" }, schema)
		).toMatchObject({ ok: true, rootFields: ["homePersonalDesk"], rateLimitCostUnits: 30 });
		expect(
			validateGraphQLRequestLimits(
				{ query: "query { homeGameweek(eventId: 1) { transfersState gameweekDesk { eventId } } }" },
				schema
			)
		).toMatchObject({ ok: true, rootFields: ["homeGameweek"], rateLimitCostUnits: 5 });
		expect(
			validateGraphQLRequestLimits(
				{ query: "query { homePublicBootstrap { context { revision } fixtures { id } } }" },
				schema
			)
		).toMatchObject({ ok: true, rootFields: ["homePublicBootstrap"], rateLimitCostUnits: 5 });
		expect(
			validateGraphQLRequestLimits(
				{ query: "query { homeMarketPulse { mostSelected { playerId } } }" },
				schema
			)
		).toMatchObject({ ok: true, rootFields: ["homeMarketPulse"], rateLimitCostUnits: 5 });
	});

	it("charges bounded My FPL review desks and detail reads", () => {
		for (const [query, rateLimitCostUnits] of [
			["query { myFplManagerReview { state } }", 8],
			["query { myFplManagerGameweek(eventId: 1) { state } }", 5],
			["query { myFplCompetitionSeasonPath(tournamentId: 1, throughEventId: 1) { state } }", 5],
			["query { myFplCompetitionSetupStatus(tournamentId: 1) { ready } }", 5],
		] as const) {
			expect(validateGraphQLRequestLimits({ query }, schema)).toMatchObject({
				ok: true,
				rateLimitCostUnits,
			});
		}

		for (const query of [
			"query { myFplCompetitionsDesk { state } }",
			"query { myFplCompetitionBoard(tournamentId: 1, eventId: 1) { state } }",
		]) {
			expect(validateGraphQLRequestLimits({ query }, schema)).toMatchObject({
				ok: true,
				rateLimitCostUnits: 10,
			});
		}
	});

	it("scopes wider AST budgets to one exact Manager Review root", () => {
		const reviewFields = Array.from({ length: 250 }, () => "__typename").join(" ");
		expect(
			validateGraphQLRequestLimits(
				{ query: `query { myFplManagerReview { ${reviewFields} } }` },
				schema
			)
		).toMatchObject({
			ok: true,
			rootFields: ["myFplManagerReview"],
			rateLimitCostUnits: 8,
		});

		expect(
			validateGraphQLRequestLimits(
				{ query: `query { review: myFplManagerReview { ${reviewFields} } }` },
				schema
			)
		).toMatchObject({ ok: false, code: "QUERY_TOO_COMPLEX" });

		const oversizedReview = Array.from({ length: 360 }, () => "__typename").join(" ");
		expect(
			validateGraphQLRequestLimits(
				{ query: `query { myFplManagerReview { ${oversizedReview} } }` },
				schema
			)
		).toMatchObject({ ok: false, code: "QUERY_TOO_COMPLEX" });

		const gameweekFields = Array.from({ length: 110 }, () => "__typename").join(" ");
		expect(
			validateGraphQLRequestLimits(
				{ query: `query { myFplManagerGameweek(eventId: 1) { ${gameweekFields} } }` },
				schema
			)
		).toMatchObject({
			ok: true,
			rootFields: ["myFplManagerGameweek"],
			rateLimitCostUnits: 5,
		});
	});

	it("charges V2 tournament review roots by bounded workload", () => {
		const cases = [
			["query { myTournamentReviewCatalog { tournaments { tournamentId } } }", 10],
			["query { myTournamentGameweekReview(tournamentId: 6953, eventId: 4) { state } }", 20],
			["query { myTournamentSeasonReview(tournamentId: 6953, throughEventId: 4) { state } }", 20],
			["query { myTournamentReviewStatus(tournamentId: 6953) { tournamentId } }", 5],
		] as const;
		for (const [query, rateLimitCostUnits] of cases) {
			expect(validateGraphQLRequestLimits({ query }, schema)).toMatchObject({
				ok: true,
				rateLimitCostUnits,
			});
		}
	});

	it("charges a tournament review page once across mutually exclusive format branches", () => {
		const fields = Array.from({ length: 100 }, () => "state").join(" ");
		for (const query of [
			`query { myTournamentGameweekReview(tournamentId: 1, eventId: 1, first: 100) { ${fields} } }`,
			`query { myTournamentSeasonReview(tournamentId: 1, throughEventId: 1, first: 100) { ${fields} } }`,
		]) {
			expect(validateGraphQLRequestLimits({ query }, schema)).toMatchObject({ ok: true });
		}
	});

	it("allows one bounded competitions desk projection above the generic AST ceiling", () => {
		const fields = Array.from({ length: 110 }, () => "__typename").join(" ");
		expect(
			validateGraphQLRequestLimits(
				{ query: `query { myFplCompetitionsDesk { ${fields} } }` },
				schema
			)
		).toMatchObject({
			ok: true,
			rootFields: ["myFplCompetitionsDesk"],
			rateLimitCostUnits: 10,
		});

		expect(
			validateGraphQLRequestLimits({ query: `query { events { ${fields} } }` }, schema)
		).toMatchObject({ ok: false, code: "QUERY_TOO_COMPLEX" });

		const oversized = Array.from({ length: 205 }, () => "__typename").join(" ");
		expect(
			validateGraphQLRequestLimits(
				{ query: `query { myFplCompetitionsDesk { ${oversized} } }` },
				schema
			)
		).toMatchObject({ ok: false, code: "QUERY_TOO_COMPLEX" });
	});

	it("allows the bounded player stats timeline projection above the generic AST ceiling", () => {
		const fields = Array.from({ length: 130 }, () => "__typename").join(" ");
		expect(
			validateGraphQLRequestLimits(
				{ query: `query { playerStatsDesk(playerIds: [1], eventId: 1) { ${fields} } }` },
				schema
			)
		).toMatchObject({ ok: true, rootFields: ["playerStatsDesk"] });

		const oversized = Array.from({ length: 140 }, () => "__typename").join(" ");
		expect(
			validateGraphQLRequestLimits(
				{ query: `query { playerStatsDesk(playerIds: [1], eventId: 1) { ${oversized} } }` },
				schema
			)
		).toMatchObject({ ok: false, code: "QUERY_TOO_COMPLEX" });
	});

	it("allows the bounded player state profile projection above the generic AST ceiling", () => {
		const fields = Array.from({ length: 110 }, () => "__typename").join(" ");
		expect(
			validateGraphQLRequestLimits(
				{ query: `query { playerStateProfile(playerId: 1) { ${fields} } }` },
				schema
			)
		).toMatchObject({ ok: true, rootFields: ["playerStateProfile"] });

		const oversized = Array.from({ length: 205 }, () => "__typename").join(" ");
		expect(
			validateGraphQLRequestLimits(
				{ query: `query { playerStateProfile(playerId: 1) { ${oversized} } }` },
				schema
			)
		).toMatchObject({ ok: false, code: "QUERY_TOO_COMPLEX" });
	});

	it("accepts the exact bounded Web live-points projection", async () => {
		const query = await Bun.file(
			new URL("../fixtures/web-get-live-calc-points.graphql", import.meta.url)
		).text();
		let astNodes = 0;
		visit(parse(query), { enter: () => void (astNodes += 1) });

		expect(astNodes).toBe(280);
		expect(
			validateGraphQLRequestLimits({ query, variables: { eventId: 1, entryId: 1 } }, schema)
		).toMatchObject({
			ok: true,
			weightedComplexity: 122,
			rateLimitCostUnits: 13,
			rootFields: ["calcLivePointsByEntry"],
		});
	});

	it("keeps the live-points AST allowance scoped to one exact bounded root", () => {
		const fieldsWithinAllowance = Array.from({ length: 110 }, () => "__typename").join(" ");
		const fieldsAboveAllowance = Array.from({ length: 170 }, () => "__typename").join(" ");

		expect(
			validateGraphQLRequestLimits(
				{
					query: `query { calcLivePointsByEntry(eventId: 1, entryId: 1) { ${fieldsWithinAllowance} } }`,
				},
				schema
			)
		).toMatchObject({ ok: true, rootFields: ["calcLivePointsByEntry"] });
		expect(
			validateGraphQLRequestLimits(
				{
					query: `query { live: calcLivePointsByEntry(eventId: 1, entryId: 1) { ${fieldsWithinAllowance} } }`,
				},
				schema
			)
		).toMatchObject({ ok: false, code: "QUERY_TOO_COMPLEX" });
		expect(
			validateGraphQLRequestLimits(
				{
					query: `query { calcLivePointsByEntry(eventId: 1, entryId: 1) { ${fieldsWithinAllowance} } events { id } }`,
				},
				schema
			)
		).toMatchObject({ ok: false, code: "QUERY_TOO_COMPLEX" });
		expect(
			validateGraphQLRequestLimits(
				{
					query: `query { calcLivePointsByEntry(eventId: 1, entryId: 1) { ${fieldsAboveAllowance} } }`,
				},
				schema
			)
		).toMatchObject({ ok: false, code: "QUERY_TOO_COMPLEX" });
	});

	it("accepts the exact bounded Web live-competition board projection", async () => {
		const query = await Bun.file(
			new URL("../fixtures/web-get-entry-live-competition-board.graphql", import.meta.url)
		).text();
		let astNodes = 0;
		visit(parse(query), { enter: () => void (astNodes += 1) });

		expect(astNodes).toBe(188);
		expect(
			validateGraphQLRequestLimits(
				{
					query,
					variables: {
						entryId: 1,
						tournamentId: 1,
						eventId: 1,
						input: { first: 20 },
					},
				},
				schema
			)
		).toMatchObject({
			ok: true,
			rootFields: ["entryLiveCompetitionBoard"],
		});
	});

	it("keeps the live-board AST allowance scoped to one exact bounded root", () => {
		const fieldsWithinAllowance = Array.from({ length: 170 }, () => "__typename").join(" ");
		const fieldsAboveAllowance = Array.from({ length: 205 }, () => "__typename").join(" ");
		const root = (fields: string) =>
			"entryLiveCompetitionBoard(entryId: 1, tournamentId: 1, eventId: 1) { " + fields + " }";

		expect(
			validateGraphQLRequestLimits(
				{ query: "query { " + root(fieldsWithinAllowance) + " }" },
				schema
			)
		).toMatchObject({ ok: true, rootFields: ["entryLiveCompetitionBoard"] });
		expect(
			validateGraphQLRequestLimits(
				{ query: "query { board: " + root(fieldsWithinAllowance) + " }" },
				schema
			)
		).toMatchObject({ ok: false, code: "QUERY_TOO_COMPLEX" });
		expect(
			validateGraphQLRequestLimits(
				{ query: "query { " + root(fieldsWithinAllowance) + " events { id } }" },
				schema
			)
		).toMatchObject({ ok: false, code: "QUERY_TOO_COMPLEX" });
		expect(
			validateGraphQLRequestLimits(
				{ query: "query { " + root(fieldsAboveAllowance) + " }" },
				schema
			)
		).toMatchObject({ ok: false, code: "QUERY_TOO_COMPLEX" });
	});

	it("keeps the official H2H publication allowance scoped to one exact root", () => {
		const fieldsWithinAllowance = Array.from({ length: 105 }, () => "__typename").join(" ");
		const fieldsAboveAllowance = Array.from({ length: 125 }, () => "__typename").join(" ");
		const root = (fields: string) =>
			"tournamentOfficialH2H(tournamentId: 1, eventId: 1) { " + fields + " }";

		expect(
			validateGraphQLRequestLimits(
				{ query: "query { " + root(fieldsWithinAllowance) + " }" },
				schema
			)
		).toMatchObject({ ok: true, rootFields: ["tournamentOfficialH2H"] });
		expect(
			validateGraphQLRequestLimits(
				{ query: "query { h2h: " + root(fieldsWithinAllowance) + " }" },
				schema
			)
		).toMatchObject({ ok: false, code: "QUERY_TOO_COMPLEX" });
		expect(
			validateGraphQLRequestLimits(
				{ query: "query { " + root(fieldsAboveAllowance) + " }" },
				schema
			)
		).toMatchObject({ ok: false, code: "QUERY_TOO_COMPLEX" });
	});

	it("allows standard introspection where Apollo has enabled it", () => {
		const result = validateGraphQLRequestLimits({ query: getIntrospectionQuery() }, schema);
		expect(result).toMatchObject({
			ok: true,
			weightedComplexity: 1,
			rateLimitCostUnits: 1,
		});
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

	it("charges effective list defaults when a caller supplies null", () => {
		for (const payload of [
			{ query: "query { players(limit: null) { id } }" },
			{
				query: "query Players($limit: Int) { players(limit: $limit) { id } }",
				variables: { limit: null },
			},
		]) {
			expect(validateGraphQLRequestLimits(payload, schema)).toMatchObject({
				ok: true,
				weightedComplexity: 100,
				rateLimitCostUnits: 10,
			});
		}
	});

	it("charges the repositories' 200-row list maximum", () => {
		expect(
			validateGraphQLRequestLimits({ query: "query { players(limit: 200) { id } }" }, schema)
		).toMatchObject({
			ok: true,
			weightedComplexity: 400,
			rateLimitCostUnits: 40,
		});
	});

	it("accepts the bounded player picker and rejects a roster-sized page", () => {
		const query = `
			query PlayerPicker($limit: Int!) {
				playersForPicker(search: "Gabriel", limit: $limit) {
					items { id webName position team { id name shortName } }
					nextCursor
					totalCount
				}
			}
		`;
		expect(validateGraphQLRequestLimits({ query, variables: { limit: 20 } }, schema)).toMatchObject(
			{
				ok: true,
				weightedComplexity: 220,
				rateLimitCostUnits: 5,
			}
		);
		expect(validateGraphQLRequestLimits({ query, variables: { limit: 100 } }, schema)).toEqual({
			ok: false,
			code: "QUERY_TOO_COMPLEX",
			message: "GraphQL operation exceeds weighted complexity 600",
		});
	});

	it("charges the Player Stats bootstrap directory without multiplying fixed siblings", () => {
		const result = validateGraphQLRequestLimits(
			{
				query: `
					query GetPlayerStatsBootstrap($limit: Int = 20) {
						playerStatsBootstrap(limit: $limit) {
							context {
								season revision sourceCheckedAt currentEventId nextEventId
								nextDeadlineTime latestFinishedEventId
							}
							statsContext {
								status revision sourceCheckedAt publishedAt rowCount expectedRowCount
							}
							teams { id name shortName }
							directory {
								items {
									id webName position price selectedByPercent totalPoints form
									team { id name shortName }
								}
								totalCount nextCursor
							}
						}
					}
				`,
				variables: { limit: 20 },
			},
			schema
		);

		expect(result).toMatchObject({
			ok: true,
			weightedComplexity: 54,
			rateLimitCostUnits: 10,
			rootFields: ["playerStatsBootstrap"],
		});
	});

	it("keeps the bounded Market availability page below the public complexity guard", () => {
		const result = validateGraphQLRequestLimits(
			{
				query: `
					query MarketAvailabilityPage($limit: Int = 20, $offset: Int = 0) {
						marketAvailabilityPage(limit: $limit, offset: $offset) {
							context { revision source snapshotDate capturedAt rowCount }
							items {
								player {
									playerId playerCode webName teamId teamName teamShortName
									position price selectedByPercent
								}
								status previousStatus news newsAdded observedDate
								chanceOfPlayingThisRound chanceOfPlayingNextRound
							}
							totalCount nextOffset
						}
					}
				`,
				variables: { limit: 20, offset: 0 },
			},
			schema
		);

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.message);
		expect(result.weightedComplexity).toBeLessThan(600);
		expect(result.rateLimitCostUnits).toBe(5);
	});

	it("keeps the fixed-size Market pulse below the public complexity guard", () => {
		const result = validateGraphQLRequestLimits(
			{
				query: `
					query MarketPulse($days: Int = 7) {
						marketPulse(days: $days) {
							coverage {
								requestedDays observedDays firstDate latestDate capturedAt complete stale
							}
							mostSelected { ...MarketPlayerFields }
							transferMovers { player { ...MarketPlayerFields } transfersIn transfersOut netTransfers }
							availabilityUpdates {
								player { ...MarketPlayerFields }
								status previousStatus news newsAdded observedDate
								chanceOfPlayingThisRound chanceOfPlayingNextRound
							}
							availabilityHighlights {
								player { ...MarketPlayerFields }
								status previousStatus news newsAdded observedDate
								chanceOfPlayingThisRound chanceOfPlayingNextRound
							}
							newPlayers { player { ...MarketPlayerFields } firstObservedDate }
							priceChanges {
								player { ...MarketPlayerFields }
								changeDate oldPrice newPrice change direction
							}
						}
					}
					fragment MarketPlayerFields on MarketPlayer {
						playerId playerCode webName teamId teamName teamShortName position price selectedByPercent
					}
				`,
				variables: { days: 14 },
			},
			schema
		);

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.message);
		expect(result.weightedComplexity).toBeLessThan(600);
		expect(result.rateLimitCostUnits).toBe(10);
	});

	it("keeps the explicit ownership period roots within the public complexity guard", () => {
		const result = validateGraphQLRequestLimits(
			{
				query: `
					query MarketOwnership {
						marketOwnershipOverview(period: DAILY) {
							period
							coverage { status requestedDays observedDays fromDate toDate missingDates }
							risers { player { playerId } fromSelectedByPercent toSelectedByPercent changePercentagePoints fromDate toDate }
							fallers { player { playerId } fromSelectedByPercent toSelectedByPercent changePercentagePoints fromDate toDate }
						}
						marketOwnershipDay {
							date
							coverage { status requestedDays observedDays missingDates }
							risers { player { playerId } changePercentagePoints }
							fallers { player { playerId } changePercentagePoints }
						}
					}
				`,
			},
			schema
		);

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.message);
		expect(result.weightedComplexity).toBeLessThan(600);
		expect(result.rateLimitCostUnits).toBe(20);
	});

	it("sums heavy root floors, including aliases", () => {
		const result = validateGraphQLRequestLimits({
			query:
				"query { first: liveMatchday { snapshot { eventId } } second: liveMatchday { snapshot { eventId } } leagueLiveHead(entryId: 1, tournamentId: 1, eventId: 1, mode: CLASSIC) { eventId } }",
		});
		expect(result).toMatchObject({ ok: true });
	});

	it("charges each unpaginated tournament participant lookup", () => {
		const result = validateGraphQLRequestLimits({
			query:
				"query { first: tournamentParticipants(tournamentId: 1) { entryId } second: tournamentParticipants(tournamentId: 2) { entryId } }",
		});
		expect(result).toMatchObject({ ok: true, rateLimitCostUnits: 60 });
	});

	it("charges tournament reporting roots for their database work", () => {
		const result = validateGraphQLRequestLimits({
			query:
				"query { tournamentEntryRankingSummary(tournamentId: 1, eventId: 3, entryId: 7) { overallPoints } tournamentSeasonSnapshot(tournamentId: 1, eventId: 3) { asOfEventId } }",
		});
		expect(result).toMatchObject({ ok: true, rateLimitCostUnits: 40 });
	});

	it("charges the V2 official H2H publication root", () => {
		const result = validateGraphQLRequestLimits({
			query:
				"query { tournamentOfficialH2H(tournamentId: 1, eventId: 3) { eventId } leagueLiveHead(entryId: 7, tournamentId: 1, eventId: 3, mode: H2H) { eventId } }",
		});
		expect(result).toMatchObject({ ok: true, rateLimitCostUnits: 6 });
	});

	it("charges every aliased liveScores full-event lookup", () => {
		const result = validateGraphQLRequestLimits({
			query:
				"query { a: liveScores(eventId: 1) { totalPoints } b: liveScores(eventId: 1) { totalPoints } c: liveScores(eventId: 1) { totalPoints } d: liveScores(eventId: 1) { totalPoints } e: liveScores(eventId: 1) { totalPoints } }",
		});
		expect(result).toMatchObject({ ok: true, rateLimitCostUnits: 25 });
	});

	it("rejects negative list limits from literals and variables", () => {
		for (const payload of [
			{ query: "query { eventLive(eventId: 1) { topPerformers(limit: -1) { totalPoints } } }" },
			{
				query:
					"query EventLive($limit: Int) { eventLive(eventId: 1) { topPerformers(limit: $limit) { totalPoints } } }",
				variables: { limit: -1 },
			},
		]) {
			expect(validateGraphQLRequestLimits(payload, schema)).toMatchObject({
				ok: false,
				code: "QUERY_TOO_COMPLEX",
				message: "GraphQL list limits must not be negative",
			});
		}
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

	it("accepts and charges the bounded fifteen-player live explain batch", () => {
		const result = validateGraphQLRequestLimits(
			{
				query:
					"query Batch($elementIds: [Int!]!) { eventLiveExplains(eventId: 1, elementIds: $elementIds) { elementId breakdown { fixtureId stats { identifier points } } } }",
				variables: { elementIds: Array.from({ length: 15 }, (_, index) => index + 1) },
			},
			schema
		);
		expect(result).toMatchObject({ ok: true });
		if (!result.ok) throw new Error(result.message);
		expect(result.rateLimitCostUnits).toBeGreaterThanOrEqual(5);
	});

	it("rejects live explain batches over fifteen players before execution", () => {
		const result = validateGraphQLRequestLimits(
			{
				query:
					"query Batch($elementIds: [Int!]!) { eventLiveExplains(eventId: 1, elementIds: $elementIds) { elementId } }",
				variables: { elementIds: Array.from({ length: 16 }, (_, index) => index + 1) },
			},
			schema
		);
		expect(result).toMatchObject({
			ok: false,
			code: "QUERY_TOO_COMPLEX",
			message: "GraphQL elementIds batch exceeds 15 players",
		});
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
});
