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

function walkDirectSelectionsForField(
	selections: readonly SelectionNode[] | undefined,
	fragments: Record<string, FragmentDefinitionNode>,
	fieldName: string
): boolean {
	if (!selections?.length) return false;
	for (const selection of selections) {
		if (selection.kind === "Field") {
			if (selection.name.value === fieldName) return true;
			continue;
		}
		if (selection.kind === "InlineFragment") {
			if (walkDirectSelectionsForField(selection.selectionSet.selections, fragments, fieldName)) {
				return true;
			}
			continue;
		}
		const definition = fragments[selection.name.value];
		if (
			definition &&
			walkDirectSelectionsForField(definition.selectionSet.selections, fragments, fieldName)
		) {
			return true;
		}
	}
	return false;
}

/** Whether the current field's selection set asks for a nested `LivePerformance.{fieldName}` (handles fragments). */
export function parentSelectionRequestsField(info: GraphQLResolveInfo, fieldName: string): boolean {
	return info.fieldNodes.some((node) =>
		walkSelectionsForField(node.selectionSet?.selections, info.fragments, fieldName)
	);
}

/** Whether the current root selection asks for a direct child field, including fragments. */
export function directSelectionRequestsField(info: GraphQLResolveInfo, fieldName: string): boolean {
	return info.fieldNodes.some((node) =>
		walkDirectSelectionsForField(node.selectionSet?.selections, info.fragments, fieldName)
	);
}
