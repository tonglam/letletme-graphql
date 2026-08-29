import { describe, expect, test } from "bun:test";
import { buildSchema } from "graphql";
import {
	deprecatedSchemaUsageMetric,
	validateDeprecationManifest,
	validateSchemaDeprecationCoverage,
} from "../../scripts/check-deprecation-manifest";
import {
	GRAPHQL_DOMAIN_MANIFEST,
	validateGraphQLConditionalAuthAgainstSchema,
	validateGraphQLDomainManifest,
} from "../../src/graphql/domain-manifest";
import { schema } from "../../src/graphql/schema";

describe("GraphQL domain manifest", () => {
	test("points every declared schema and resolver module at an existing source file", async () => {
		expect(validateGraphQLDomainManifest(schema)).toEqual([]);
		const foundation = GRAPHQL_DOMAIN_MANIFEST.find((entry) => entry.name === "foundation");
		expect(foundation).toMatchObject({
			typeDefsModules: ["src/graphql/base-schema.ts", "src/graphql/data-completeness.ts"],
			resolversModules: ["src/graphql/base-schema.ts"],
		});
		for (const entry of GRAPHQL_DOMAIN_MANIFEST) {
			for (const modulePath of [...entry.typeDefsModules, ...entry.resolversModules]) {
				expect(await Bun.file(modulePath).exists()).toBe(true);
			}
		}
	});

	test("compares declared roots bidirectionally with the executable schema", () => {
		const errors = validateGraphQLDomainManifest(
			buildSchema("type Query { _empty: String invented: String }")
		);
		expect(errors).toContain("manifest root field is not executable: me");
		expect(errors).toContain("unassigned executable root field: invented");
	});

	test("documents effective special floors and argument-sensitive authorization", () => {
		const trends = GRAPHQL_DOMAIN_MANIFEST.find((entry) => entry.name === "trends");
		expect(trends?.conditionalAuth).toEqual([
			{ field: "trendCohorts", argument: "access", equals: "MINE", access: "viewerEntry" },
			{
				field: "trendCohortSnapshot",
				argument: "access",
				equals: "MINE",
				access: "viewerEntry",
			},
		]);
		const myFpl = GRAPHQL_DOMAIN_MANIFEST.find((entry) => entry.name === "my-fpl");
		expect(myFpl?.conditionalAuth).toEqual([
			{
				field: "myFplCompetitionsDesk",
				argument: "tournamentId",
				when: "provided",
				access: "viewerTournamentMember",
			},
		]);
		expect(myFpl?.authByRootField.myFplCompetitionsDesk).toEqual([
			"viewerEntry",
			"viewerTournamentMember",
		]);
		const players = GRAPHQL_DOMAIN_MANIFEST.find((entry) => entry.name === "players");
		expect(players?.rateLimitBudget.playersForPicker).toBe(5);
		expect(players?.rateLimitBudget.teams).toBe(5);
		const market = GRAPHQL_DOMAIN_MANIFEST.find((entry) => entry.name === "market");
		expect(market?.rateLimitBudget.marketSnapshotContext).toBe(5);
		const miniProgram = GRAPHQL_DOMAIN_MANIFEST.find((entry) => entry.name === "mini-program");
		expect(miniProgram?.rateLimitBudget.miniProgramNotice).toBe(5);
		const entryLiveDomain = GRAPHQL_DOMAIN_MANIFEST.find((entry) => entry.name === "entry-live");
		expect(entryLiveDomain?.rateLimitBudget.calcLivePointsForEntries).toBe(10);
		expect(players?.authByRootField).toMatchObject({
			players: ["public"],
			teams: ["public"],
		});
		expect(
			GRAPHQL_DOMAIN_MANIFEST.find((entry) => entry.name === "home")?.authByRootField
		).toMatchObject({
			homePublicBootstrap: ["public"],
			homePersonalDesk: ["viewerEntry"],
		});
		expect(trends?.authByRootField).toMatchObject({
			trendCohorts: ["public", "viewerEntry"],
			trendCohortSnapshot: ["public", "viewerEntry"],
		});
	});

	test("validates conditional auth arguments and predicates against GraphQL types", () => {
		const validSchema = buildSchema(`
			enum TrendCohortAccess { PUBLIC MINE }
			type Query {
				trendCohorts(access: TrendCohortAccess!): String
				trendCohortSnapshot(access: TrendCohortAccess = PUBLIC): String
				myFplCompetitionsDesk(tournamentId: Int): String
			}
		`);
		expect(validateGraphQLConditionalAuthAgainstSchema(validSchema)).toEqual([]);

		const typoSchema = buildSchema(`
			enum TrendCohortAccess { PUBLIC MINE }
			type Query {
				trendCohorts(access: TrendCohortAccess!): String
				trendCohortSnapshot(access: TrendCohortAccess): String
				myFplCompetitionsDesk(tournamentID: Int): String
			}
		`);
		const errors = validateGraphQLConditionalAuthAgainstSchema(typoSchema);
		expect(errors).toContain(
			"Query.myFplCompetitionsDesk.tournamentId: conditional auth argument is not defined in the schema"
		);
	});

	test("rejects conditional equality values that do not match the argument type", () => {
		const schemaWithInvalidEnum = buildSchema(`
			enum TrendCohortAccess { PUBLIC }
			type Query {
				trendCohorts(access: TrendCohortAccess!): String
				trendCohortSnapshot(access: TrendCohortAccess): String
				myFplCompetitionsDesk(tournamentId: Int): String
			}
		`);
		expect(validateGraphQLConditionalAuthAgainstSchema(schemaWithInvalidEnum)).toContain(
			"Query.trendCohorts.access: equals must name a value in enum TrendCohortAccess"
		);
	});
});

describe("deprecation manifest validation", () => {
	const valid = {
		id: "field-a",
		symbol: "Query.fieldA",
		owner: "graphql",
		introducedAt: "2026-08-01",
		removalTarget: "2027-03-01",
		status: "deprecated",
		usageMetric: "graphql_requests_total",
	};

	test("accepts only the two lifecycle states", () => {
		expect(validateDeprecationManifest([{ ...valid, status: "pending" }], "2026-08-28")).toContain(
			"field-a: status must be deprecated or removed"
		);
	});

	test("rejects malformed and impossible calendar dates", () => {
		const errors = validateDeprecationManifest(
			[
				{ ...valid, introducedAt: "2026-8-1" },
				{ ...valid, id: "field-b", removalTarget: "2027-02-30" },
			],
			"2026-08-28"
		);
		expect(errors).toContain("field-a: introducedAt must be YYYY-MM-DD");
		expect(errors).toContain("field-b: removalTarget must be YYYY-MM-DD");
	});

	test("rejects expired targets and requires a canonical removal date", () => {
		const errors = validateDeprecationManifest(
			[
				{ ...valid, removalTarget: "2026-08-28" },
				{
					...valid,
					id: "field-b",
					status: "removed",
					removedAt: "not-a-date",
					removalTarget: undefined,
				},
			],
			"2026-08-28"
		);
		expect(errors).toContain("field-a: removalTarget has expired");
		expect(errors).toContain("field-b: removedAt must be YYYY-MM-DD");
	});

	test("rejects future and chronologically impossible lifecycle dates", () => {
		const errors = validateDeprecationManifest(
			[
				{
					...valid,
					status: "removed",
					removedAt: "2026-08-29",
					removalTarget: undefined,
				},
				{
					...valid,
					id: "field-b",
					introducedAt: "2026-08-01",
					status: "removed",
					removedAt: "2025-08-01",
					removalTarget: undefined,
				},
				{
					...valid,
					id: "field-c",
					introducedAt: "2026-08-29",
				},
			],
			"2026-08-28"
		);
		expect(errors).toContain("field-a: removedAt cannot be in the future");
		expect(errors).toContain("field-b: removedAt cannot predate introducedAt");
		expect(errors).toContain("field-c: introducedAt cannot be in the future");
	});

	test("requires every executable deprecation and its symbol-level metric", () => {
		const deprecatedSchema = buildSchema(`
			type Query {
				legacy: String @deprecated(reason: "Use current")
				current: String
			}
		`);
		expect(validateSchemaDeprecationCoverage([], deprecatedSchema)).toEqual([
			"missing schema deprecation: Query.legacy",
		]);
		const symbol = "Query.legacy";
		expect(
			validateSchemaDeprecationCoverage(
				[
					{
						...valid,
						symbol,
						usageMetric: deprecatedSchemaUsageMetric(symbol),
					},
				],
				deprecatedSchema
			)
		).toEqual([]);
	});

	test("requires manifest coverage for deprecated directive arguments", () => {
		const directiveSchema = buildSchema(`
			directive @legacy(note: String @deprecated(reason: "Use current")) on FIELD
			type Query { current: String }
		`);
		const symbol = "@legacy(note:)";
		expect(validateSchemaDeprecationCoverage([], directiveSchema)).toEqual([
			`missing schema deprecation: ${symbol}`,
		]);
		expect(
			validateSchemaDeprecationCoverage(
				[
					{
						...valid,
						symbol,
						usageMetric: deprecatedSchemaUsageMetric(symbol),
					},
				],
				directiveSchema
			)
		).toEqual([]);
	});

	test("rejects a removed symbol reintroduced without a deprecation marker", () => {
		const reintroducedSchema = buildSchema(`type Query { entry: String current: String }`);
		const errors = validateSchemaDeprecationCoverage(
			[
				{
					...valid,
					id: "entry-hard-cut",
					symbol: "Query.entry",
					status: "removed",
					removedAt: "2026-08-28",
					removalTarget: undefined,
				},
			],
			reintroducedSchema
		);
		expect(errors).toContain("entry-hard-cut: removed symbol is present in the executable schema");
	});
});
