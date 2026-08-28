import { describe, expect, test } from "bun:test";
import { buildSchema } from "graphql";
import {
	deprecatedFieldUsageMetric,
	validateDeprecationManifest,
	validateSchemaDeprecationCoverage,
} from "../../scripts/check-deprecation-manifest";
import {
	GRAPHQL_DOMAIN_MANIFEST,
	validateGraphQLDomainManifest,
} from "../../src/graphql/domain-manifest";

describe("GraphQL domain manifest", () => {
	test("points every declared schema and resolver module at an existing source file", async () => {
		expect(validateGraphQLDomainManifest()).toEqual([]);
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
		const players = GRAPHQL_DOMAIN_MANIFEST.find((entry) => entry.name === "players");
		expect(players?.rateLimitBudget.playersForPicker).toBe(5);
		const entryLive = GRAPHQL_DOMAIN_MANIFEST.find((entry) => entry.name === "entry-live");
		expect(entryLive?.rateLimitBudget.calcLivePointsForEntries).toBe(10);
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
			],
			"2026-08-28"
		);
		expect(errors).toContain("field-a: removedAt cannot be in the future");
		expect(errors).toContain("field-b: removedAt cannot predate introducedAt");
	});

	test("requires every executable deprecation and its field-level metric", () => {
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
						usageMetric: deprecatedFieldUsageMetric(symbol),
					},
				],
				deprecatedSchema
			)
		).toEqual([]);
	});
});
