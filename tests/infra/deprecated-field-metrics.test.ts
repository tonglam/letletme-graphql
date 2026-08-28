import { expect, test } from "bun:test";
import { metrics } from "../../src/infra/metrics";

test("deprecated GraphQL field selections use a field-level controlled label", async () => {
	metrics.graphqlDeprecatedFieldSelections.labels("LiveCalcData.rank").inc();
	const rendered = await metrics.registry.metrics();
	expect(rendered).toContain(
		'graphql_deprecated_field_selections_total{symbol="LiveCalcData.rank"} 1'
	);
});
