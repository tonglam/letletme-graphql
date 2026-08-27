import { describe, expect, test } from "bun:test";
import { validateDeprecationManifest } from "../../scripts/check-deprecation-manifest";
import {
	GRAPHQL_DOMAIN_MANIFEST,
	validateGraphQLDomainManifest,
} from "../../src/graphql/domain-manifest";

describe("GraphQL domain manifest", () => {
	test("points every declared schema and resolver module at an existing source file", async () => {
		expect(validateGraphQLDomainManifest()).toEqual([]);
		const foundation = GRAPHQL_DOMAIN_MANIFEST.find((entry) => entry.name === "foundation");
		expect(foundation).toMatchObject({
			typeDefsModule: "src/graphql/base-schema.ts",
			resolversModule: "src/graphql/base-schema.ts",
		});
		for (const entry of GRAPHQL_DOMAIN_MANIFEST) {
			expect(await Bun.file(entry.typeDefsModule).exists()).toBe(true);
			expect(await Bun.file(entry.resolversModule).exists()).toBe(true);
		}
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
});
