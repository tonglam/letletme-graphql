import {
	Kind,
	parse,
	valueFromASTUntyped,
	visit,
	type DocumentNode,
	type FragmentDefinitionNode,
	type OperationDefinitionNode,
	type SelectionSetNode,
} from "graphql";

export const GRAPHQL_LIMITS = {
	maxDepth: 10,
	maxRootFields: 5,
	maxAliases: 20,
	maxAstNodes: 200,
	maxComplexity: 500,
} as const;

type GraphQLPayload = {
	query?: unknown;
	variables?: unknown;
	operationName?: unknown;
};

export type GraphQLRequestShape = "query" | "mutation" | "subscription" | "unknown";

export type GraphQLLimitResult =
	| {
			ok: true;
			shape: GraphQLRequestShape;
			securityOperation: boolean;
			securityOperationCount: number;
	  }
	| {
			ok: false;
			message: string;
			code: "QUERY_TOO_COMPLEX";
	  };

const asVariables = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

const operationFor = (
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

const fragmentsFor = (document: DocumentNode): Map<string, FragmentDefinitionNode> =>
	new Map(
		document.definitions
			.filter(
				(definition): definition is FragmentDefinitionNode =>
					definition.kind === Kind.FRAGMENT_DEFINITION
			)
			.map((fragment) => [fragment.name.value, fragment])
	);

const listMultiplier = (
	fieldArguments: readonly {
		name: { value: string };
		value: Parameters<typeof valueFromASTUntyped>[0];
	}[],
	variables: Record<string, unknown>
): number => {
	let multiplier = 1;
	for (const argument of fieldArguments) {
		const value = valueFromASTUntyped(argument.value, variables);
		if (argument.name.value === "entryIds" && Array.isArray(value)) {
			multiplier = Math.max(multiplier, Math.min(value.length, 500));
		}
		if (["first", "last", "limit"].includes(argument.name.value) && typeof value === "number") {
			multiplier = Math.max(multiplier, Math.min(Math.max(value, 1), 100));
		}
	}
	return multiplier;
};

const inspectSelectionSet = ({
	selectionSet,
	fragments,
	variables,
	depth,
	multiplier,
	seenFragments,
}: {
	selectionSet: SelectionSetNode;
	fragments: Map<string, FragmentDefinitionNode>;
	variables: Record<string, unknown>;
	depth: number;
	multiplier: number;
	seenFragments: Set<string>;
}): { maxDepth: number; aliases: number; complexity: number; rootFields: string[] } => {
	let maxDepth = depth;
	let aliases = 0;
	let complexity = 0;
	const rootFields: string[] = [];

	for (const selection of selectionSet.selections) {
		if (selection.kind === Kind.FIELD) {
			if (depth === 1) rootFields.push(selection.name.value);
			if (selection.alias) aliases += 1;
			const childMultiplier = multiplier * listMultiplier(selection.arguments ?? [], variables);
			complexity += childMultiplier;
			if (selection.selectionSet) {
				const child = inspectSelectionSet({
					selectionSet: selection.selectionSet,
					fragments,
					variables,
					depth: depth + 1,
					multiplier: childMultiplier,
					seenFragments: new Set(seenFragments),
				});
				maxDepth = Math.max(maxDepth, child.maxDepth);
				aliases += child.aliases;
				complexity += child.complexity;
			}
			continue;
		}
		if (selection.kind === Kind.INLINE_FRAGMENT) {
			const child = inspectSelectionSet({
				selectionSet: selection.selectionSet,
				fragments,
				variables,
				depth,
				multiplier,
				seenFragments: new Set(seenFragments),
			});
			maxDepth = Math.max(maxDepth, child.maxDepth);
			aliases += child.aliases;
			complexity += child.complexity;
			rootFields.push(...child.rootFields);
			continue;
		}
		const fragmentName = selection.name.value;
		if (seenFragments.has(fragmentName)) continue;
		const fragment = fragments.get(fragmentName);
		if (!fragment) continue;
		const nextSeen = new Set(seenFragments);
		nextSeen.add(fragmentName);
		const child = inspectSelectionSet({
			selectionSet: fragment.selectionSet,
			fragments,
			variables,
			depth,
			multiplier,
			seenFragments: nextSeen,
		});
		maxDepth = Math.max(maxDepth, child.maxDepth);
		aliases += child.aliases;
		complexity += child.complexity;
		rootFields.push(...child.rootFields);
	}

	return { maxDepth, aliases, complexity, rootFields };
};

const reject = (message: string): GraphQLLimitResult => ({
	ok: false,
	code: "QUERY_TOO_COMPLEX",
	message,
});

export const validateGraphQLPayloadLimits = (payload: GraphQLPayload): GraphQLLimitResult => {
	if (typeof payload.query !== "string") {
		return { ok: true, shape: "unknown", securityOperation: false, securityOperationCount: 0 };
	}

	let document: DocumentNode;
	try {
		document = parse(payload.query);
	} catch {
		return { ok: true, shape: "unknown", securityOperation: false, securityOperationCount: 0 };
	}

	let astNodes = 0;
	visit(document, { enter: () => void (astNodes += 1) });
	if (astNodes > GRAPHQL_LIMITS.maxAstNodes) {
		return reject(`GraphQL document exceeds ${GRAPHQL_LIMITS.maxAstNodes} AST nodes`);
	}

	const operation = operationFor(
		document,
		typeof payload.operationName === "string" ? payload.operationName : null
	);
	if (!operation) {
		return { ok: true, shape: "unknown", securityOperation: false, securityOperationCount: 0 };
	}

	const inspection = inspectSelectionSet({
		selectionSet: operation.selectionSet,
		fragments: fragmentsFor(document),
		variables: asVariables(payload.variables),
		depth: 1,
		multiplier: 1,
		seenFragments: new Set(),
	});
	if (inspection.maxDepth > GRAPHQL_LIMITS.maxDepth) {
		return reject(`GraphQL query depth exceeds ${GRAPHQL_LIMITS.maxDepth}`);
	}
	if (inspection.rootFields.length > GRAPHQL_LIMITS.maxRootFields) {
		return reject(`GraphQL operation exceeds ${GRAPHQL_LIMITS.maxRootFields} root fields`);
	}
	if (inspection.aliases > GRAPHQL_LIMITS.maxAliases) {
		return reject(`GraphQL operation exceeds ${GRAPHQL_LIMITS.maxAliases} aliases`);
	}
	if (inspection.complexity > GRAPHQL_LIMITS.maxComplexity) {
		return reject(`GraphQL operation exceeds weighted complexity ${GRAPHQL_LIMITS.maxComplexity}`);
	}

	const securityOperationCount = inspection.rootFields.filter(
		(field) => field === "createWechatApiSession"
	).length;
	return {
		ok: true,
		shape: operation.operation,
		securityOperation: securityOperationCount > 0,
		securityOperationCount,
	};
};

export const validateGraphQLRequestLimits = (body: unknown): GraphQLLimitResult => {
	const payloads = Array.isArray(body) ? body : [body];
	let shape: GraphQLRequestShape = "unknown";
	let securityOperation = false;
	let securityOperationCount = 0;
	for (const payload of payloads) {
		if (!payload || typeof payload !== "object") continue;
		const result = validateGraphQLPayloadLimits(payload as GraphQLPayload);
		if (!result.ok) return result;
		if (result.shape === "mutation") shape = "mutation";
		else if (shape === "unknown") shape = result.shape;
		securityOperation ||= result.securityOperation;
		securityOperationCount += result.securityOperationCount;
	}
	return { ok: true, shape, securityOperation, securityOperationCount };
};
