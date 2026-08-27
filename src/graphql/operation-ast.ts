import {
	Kind,
	parse,
	valueFromASTUntyped,
	type ArgumentNode,
	type DocumentNode,
	type FragmentDefinitionNode,
	type OperationDefinitionNode,
	type SelectionSetNode,
} from "graphql";

export type GraphQLRequestPayload = {
	query?: unknown;
	variables?: unknown;
	operationName?: unknown;
};

export type GraphQLRootField = {
	name: string;
	args: Record<string, unknown>;
};

export type GraphQLOperationAnalysis = Readonly<{
	document: DocumentNode;
	operation: OperationDefinitionNode | null;
	fragments: ReadonlyMap<string, FragmentDefinitionNode>;
	variables: Record<string, unknown>;
	rootFields: readonly GraphQLRootField[];
}>;

export const asGraphQLVariables = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

export const selectGraphQLOperation = (
	document: DocumentNode,
	operationName: string | null
): OperationDefinitionNode | null => {
	const operations = document.definitions.filter(
		(definition): definition is OperationDefinitionNode =>
			definition.kind === Kind.OPERATION_DEFINITION
	);
	if (operationName) {
		return operations.find((operation) => operation.name?.value === operationName) ?? null;
	}
	return operations.length === 1 ? (operations[0] ?? null) : null;
};

export const graphQLFragments = (document: DocumentNode): Map<string, FragmentDefinitionNode> =>
	new Map(
		document.definitions
			.filter(
				(definition): definition is FragmentDefinitionNode =>
					definition.kind === Kind.FRAGMENT_DEFINITION
			)
			.map((fragment) => [fragment.name.value, fragment])
	);

const readArgs = (
	args: readonly ArgumentNode[] | undefined,
	variables: Record<string, unknown>
): Record<string, unknown> => {
	const values: Record<string, unknown> = {};
	for (const arg of args ?? []) {
		values[arg.name.value] = valueFromASTUntyped(arg.value, variables);
	}
	return values;
};

const variablesWithDefaults = (
	operation: OperationDefinitionNode | null,
	suppliedVariables: Record<string, unknown>
): Record<string, unknown> => {
	if (!operation) return suppliedVariables;
	const variables = { ...suppliedVariables };
	for (const definition of operation.variableDefinitions ?? []) {
		const name = definition.variable.name.value;
		if (!Object.hasOwn(variables, name) && definition.defaultValue) {
			variables[name] = valueFromASTUntyped(definition.defaultValue);
		}
	}
	return variables;
};

const collectRootFields = (
	selectionSet: SelectionSetNode,
	fragments: ReadonlyMap<string, FragmentDefinitionNode>,
	variables: Record<string, unknown>,
	fields: GraphQLRootField[] = [],
	seenFragments = new Set<string>()
): GraphQLRootField[] => {
	for (const selection of selectionSet.selections) {
		if (selection.kind === Kind.FIELD) {
			fields.push({
				name: selection.name.value,
				args: readArgs(selection.arguments, variables),
			});
			continue;
		}
		if (selection.kind === Kind.INLINE_FRAGMENT) {
			collectRootFields(selection.selectionSet, fragments, variables, fields, seenFragments);
			continue;
		}
		const fragmentName = selection.name.value;
		if (seenFragments.has(fragmentName)) continue;
		const fragment = fragments.get(fragmentName);
		if (!fragment) continue;
		seenFragments.add(fragmentName);
		collectRootFields(fragment.selectionSet, fragments, variables, fields, seenFragments);
	}
	return fields;
};

/**
 * Parse and select one GraphQL operation once for all admission consumers.
 * Both authorization and complexity accounting must see the same variables,
 * fragment reachability, and root-field arguments or their policies can drift.
 */
export const analyzeGraphQLOperation = (
	payload: GraphQLRequestPayload
): GraphQLOperationAnalysis => {
	if (typeof payload.query !== "string") {
		throw new TypeError("GraphQL request body must contain a query string");
	}
	const document = parse(payload.query);
	const operation = selectGraphQLOperation(
		document,
		typeof payload.operationName === "string" ? payload.operationName : null
	);
	const fragments = graphQLFragments(document);
	const variables = variablesWithDefaults(operation, asGraphQLVariables(payload.variables));
	return {
		document,
		operation,
		fragments,
		variables,
		rootFields: operation ? collectRootFields(operation.selectionSet, fragments, variables) : [],
	};
};
