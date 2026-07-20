import type { FragmentDefinitionNode, GraphQLResolveInfo, SelectionNode } from "graphql";

function walkSelectionsForField(
	selections: readonly SelectionNode[] | undefined,
	fragments: Record<string, FragmentDefinitionNode>,
	fieldName: string
): boolean {
	if (!selections?.length) {
		return false;
	}
	for (const sel of selections) {
		if (sel.kind === "Field") {
			if (sel.name.value === fieldName) {
				return true;
			}
			if (walkSelectionsForField(sel.selectionSet?.selections, fragments, fieldName)) {
				return true;
			}
		} else if (sel.kind === "InlineFragment") {
			if (walkSelectionsForField(sel.selectionSet.selections, fragments, fieldName)) {
				return true;
			}
		} else if (sel.kind === "FragmentSpread") {
			const def = fragments[sel.name.value];
			if (def && walkSelectionsForField(def.selectionSet.selections, fragments, fieldName)) {
				return true;
			}
		}
	}
	return false;
}

/** Whether the current field's selection set asks for a nested `LivePerformance.{fieldName}` (handles fragments). */
export function parentSelectionRequestsField(info: GraphQLResolveInfo, fieldName: string): boolean {
	const node = info.fieldNodes[0];
	const selections = node?.selectionSet?.selections;
	return walkSelectionsForField(selections, info.fragments, fieldName);
}
