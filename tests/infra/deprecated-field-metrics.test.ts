import { expect, test } from "bun:test";
import { recordDeprecatedSchemaUsages } from "../../src/graphql/deprecation-observability";
import { metrics } from "../../src/infra/metrics";

test("deprecated GraphQL schema usages use a controlled symbol label", async () => {
	metrics.graphqlDeprecatedSchemaUsages.labels("LiveCalcData.rank").inc();
	const rendered = await metrics.registry.metrics();
	expect(rendered).toContain(
		'graphql_deprecated_schema_usages_total{symbol="LiveCalcData.rank"} 1'
	);
});

test("deprecated usage is committed only after successful GraphQL validation", () => {
	const observed: string[] = [];
	expect(
		recordDeprecatedSchemaUsages({
			validationErrors: [new Error("invalid nested field")],
			symbols: ["Query.legacy"],
			increment: (symbol) => observed.push(symbol),
		})
	).toBe(0);
	expect(observed).toEqual([]);
	expect(
		recordDeprecatedSchemaUsages({
			symbols: ["Query.legacy", "Query.legacy"],
			increment: (symbol) => observed.push(symbol),
		})
	).toBe(1);
	expect(observed).toEqual(["Query.legacy"]);
});
