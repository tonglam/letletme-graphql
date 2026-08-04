import { describe, expect, it } from "bun:test";
import {
	parse,
	type FieldNode,
	type FragmentDefinitionNode,
	type GraphQLResolveInfo,
} from "graphql";
import {
	directSelectionRequestsField,
	parentSelectionRequestsField,
} from "../../src/graphql/selection-set";

describe("GraphQL selection helpers", () => {
	it("checks every merged field node and follows direct fragments without matching nested names", () => {
		const document = parse(`
			query {
				eventLiveExplains(eventId: 33, elementIds: [1]) { elementId }
				eventLiveExplains(eventId: 33, elementIds: [1]) { ...FullExplain }
			}
			fragment FullExplain on LiveExplain {
				stats { totalPoints }
				player { id }
			}
		`);
		const operation = document.definitions.find(
			(definition) => definition.kind === "OperationDefinition"
		);
		if (!operation || operation.kind !== "OperationDefinition") {
			throw new Error("Expected operation definition");
		}
		const fragments = Object.fromEntries(
			document.definitions
				.filter(
					(definition): definition is FragmentDefinitionNode =>
						definition.kind === "FragmentDefinition"
				)
				.map((definition) => [definition.name.value, definition])
		);
		const info = {
			fieldNodes: operation.selectionSet.selections.filter(
				(selection): selection is FieldNode => selection.kind === "Field"
			),
			fragments,
		} as unknown as GraphQLResolveInfo;

		expect(directSelectionRequestsField(info, "stats")).toBe(true);
		expect(directSelectionRequestsField(info, "player")).toBe(true);
		expect(directSelectionRequestsField(info, "totalPoints")).toBe(false);
		expect(parentSelectionRequestsField(info, "totalPoints")).toBe(true);
	});
});
