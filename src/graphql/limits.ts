import {
	Kind,
	TypeInfo,
	getNamedType,
	isEnumType,
	isInputType,
	isInputObjectType,
	isInterfaceType,
	isListType,
	isNonNullType,
	isObjectType,
	isUnionType,
	typeFromAST,
	valueFromASTUntyped,
	visit,
	visitWithTypeInfo,
	type GraphQLArgument,
	type ASTNode,
	type GraphQLCompositeType,
	type DirectiveNode,
	type GraphQLInputType,
	type GraphQLNamedType,
	type GraphQLSchema,
	type ArgumentNode,
	type FragmentDefinitionNode,
	type OperationDefinitionNode,
	type SelectionSetNode,
} from "graphql";
import { analyzeGraphQLOperation, type GraphQLRequestPayload } from "./operation-ast";

export const GRAPHQL_LIMITS = {
	maxDepth: 10,
	maxRootFields: 5,
	maxAliases: 20,
	maxAstNodes: 200,
	maxBoundedDeskAstNodes: 400,
	maxPlayerStatsDeskAstNodes: 280,
	maxPlayerStateProfileAstNodes: 240,
	maxComplexity: 600,
} as const;

// The detail desk intentionally projects both the setup/live and official-H2H
// branches in one response so the Web route can keep a single request. Keep the
// general document cap strict, but give this one bounded root enough AST room
// without relaxing depth, alias, root-field, or weighted-complexity guards.
const TOURNAMENT_DETAIL_DESK_MAX_AST_NODES = 400;
const PLAYER_STATS_DESK_MAX_AST_NODES = 280;
const PLAYER_STATE_PROFILE_MAX_AST_NODES = 240;
// The single-entry live-points response projects a fixed 15-player squad plus
// revision provenance and the bounded effective lineup. Give only this exact
// root enough document room while retaining every weighted-complexity, depth,
// alias, root-field, and rate-limit guard below.
const CALC_LIVE_POINTS_MAX_AST_NODES = 260;
// The live competition board returns at most one bounded page plus the viewer
// row, but each score carries the same traceability contract as live points.
// Scope the larger document allowance to this sole unaliased root; page-size,
// weighted-complexity, depth and rate-limit guards remain unchanged.
const ENTRY_LIVE_COMPETITION_BOARD_MAX_AST_NODES = 400;

const MAX_LIST_ARGUMENT_WEIGHT = 200;

// These roots contain a bounded list alongside fixed-size sibling projections.
// Charge the requested list once, but do not multiply unrelated siblings by it.
const NON_PROPAGATING_LIMIT_ROOTS = new Set(["playerStatsBootstrap"]);

type GraphQLPayload = GraphQLRequestPayload;

export type GraphQLRequestShape = "query" | "mutation" | "subscription" | "unknown";

export type GraphQLLimitResult =
	| {
			ok: true;
			shape: GraphQLRequestShape;
			weightedComplexity: number;
			rateLimitCostUnits: number;
			rootFields: readonly string[];
			deprecatedSymbols: readonly string[];
			deprecatedSymbolOwners: Readonly<Record<string, readonly string[]>>;
			/** Deprecated symbols used outside any field occurrence (for example, an operation directive). */
			deprecatedSymbolGlobalSymbols: readonly string[];
	  }
	| {
			ok: false;
			message: string;
			code:
				| "QUERY_TOO_COMPLEX"
				| "DUPLICATE_ENTRY_IDS"
				| "BATCHING_DISABLED"
				| "INVALID_GRAPHQL_REQUEST";
	  };

type EffectiveRootField = {
	name: string;
	responseKey: string;
};

const effectiveRootFieldsFor = (
	operation: OperationDefinitionNode,
	fragments: ReadonlyMap<string, FragmentDefinitionNode>
): { fields: EffectiveRootField[]; reachableFragments: Set<string> } => {
	const fields: EffectiveRootField[] = [];
	const reachableFragments = new Set<string>();
	const collectNestedFragments = (selectionSet: SelectionSetNode): void => {
		for (const selection of selectionSet.selections) {
			if (selection.kind === Kind.FIELD) {
				if (selection.selectionSet) collectNestedFragments(selection.selectionSet);
				continue;
			}
			if (selection.kind === Kind.INLINE_FRAGMENT) {
				collectNestedFragments(selection.selectionSet);
				continue;
			}
			if (reachableFragments.has(selection.name.value)) continue;
			const fragment = fragments.get(selection.name.value);
			if (fragment) {
				reachableFragments.add(selection.name.value);
				collectNestedFragments(fragment.selectionSet);
			}
		}
	};
	const collect = (selectionSet: SelectionSetNode): void => {
		for (const selection of selectionSet.selections) {
			if (selection.kind === Kind.FIELD) {
				fields.push({
					name: selection.name.value,
					responseKey: selection.alias?.value ?? selection.name.value,
				});
				if (selection.selectionSet) collectNestedFragments(selection.selectionSet);
				continue;
			}
			if (selection.kind === Kind.INLINE_FRAGMENT) {
				collect(selection.selectionSet);
				continue;
			}
			if (reachableFragments.has(selection.name.value)) {
				continue;
			}
			const fragment = fragments.get(selection.name.value);
			if (fragment) {
				reachableFragments.add(selection.name.value);
				collect(fragment.selectionSet);
			}
		}
	};
	collect(operation.selectionSet);
	return { fields, reachableFragments };
};

const asCompositeType = (
	value: GraphQLNamedType | null | undefined
): GraphQLCompositeType | null =>
	value && (isObjectType(value) || isInterfaceType(value) || isUnionType(value)) ? value : null;

type ListWeight = {
	multiplier: number;
	propagateToChildren: boolean;
	oversizedEntryBatch: boolean;
	oversizedLiveExplainBatch: boolean;
	duplicateEntryIds: boolean;
	negativeListLimit: boolean;
	uniqueEntryCount: number | null;
};

const listWeight = (
	fieldArguments: readonly {
		name: { value: string };
		value: Parameters<typeof valueFromASTUntyped>[0];
	}[],
	variables: Record<string, unknown>,
	schemaArguments: readonly GraphQLArgument[] = []
): ListWeight => {
	let multiplier = 1;
	let hasEntryIds = false;
	let oversizedEntryBatch = false;
	let oversizedLiveExplainBatch = false;
	let duplicateEntryIds = false;
	let negativeListLimit = false;
	let uniqueEntryCount: number | null = null;
	const argumentValues = new Map<string, unknown>();
	for (const argument of schemaArguments) {
		if (argument.defaultValue !== undefined) {
			argumentValues.set(argument.name, argument.defaultValue);
		}
	}
	for (const argument of fieldArguments) {
		const suppliedValue = valueFromASTUntyped(argument.value, variables);
		// GraphQL preserves an explicit null, but the list resolvers use nullish
		// fallbacks that match their schema defaults. Keep that effective default
		// for safety accounting so `limit: null` cannot make a large list look cheap.
		const preservesEffectiveDefault =
			suppliedValue === null && argumentValues.has(argument.name.value);
		if (
			!preservesEffectiveDefault &&
			(suppliedValue !== undefined || !argumentValues.has(argument.name.value))
		) {
			argumentValues.set(argument.name.value, suppliedValue);
		}
	}
	for (const [name, value] of argumentValues) {
		if (name === "entryIds" && Array.isArray(value)) {
			hasEntryIds = true;
			uniqueEntryCount = new Set(value).size;
			duplicateEntryIds ||= uniqueEntryCount !== value.length;
			oversizedEntryBatch ||= value.length > 500;
			multiplier = Math.max(multiplier, Math.min(value.length, 500));
		}
		if (name === "elementIds" && Array.isArray(value)) {
			oversizedLiveExplainBatch ||= value.length > 15;
			multiplier = Math.max(multiplier, Math.min(value.length, 15));
		}
		if (["first", "last", "limit"].includes(name) && typeof value === "number") {
			negativeListLimit ||= value < 0;
			multiplier = Math.max(multiplier, Math.min(Math.max(value, 1), MAX_LIST_ARGUMENT_WEIGHT));
		}
		if (name === "offset" && typeof value === "number") {
			negativeListLimit ||= value < 0;
		}
	}
	return {
		multiplier,
		// Batch resolver work is charged once at the root. Reapplying the full
		// entry count to every selected response field makes the documented
		// 500-entry limit impossible to use. Ordinary paginated lists continue
		// propagating their multiplier through their child selection.
		propagateToChildren: !hasEntryIds,
		oversizedEntryBatch,
		oversizedLiveExplainBatch,
		duplicateEntryIds,
		negativeListLimit,
		uniqueEntryCount,
	};
};

const inspectSelectionSet = ({
	selectionSet,
	fragments,
	variables,
	depth,
	multiplier,
	seenFragments,
	schema,
	parentType,
}: {
	selectionSet: SelectionSetNode;
	fragments: ReadonlyMap<string, FragmentDefinitionNode>;
	variables: Record<string, unknown>;
	depth: number;
	multiplier: number;
	seenFragments: Set<string>;
	schema?: GraphQLSchema;
	parentType: GraphQLCompositeType | null;
}): {
	maxDepth: number;
	aliases: number;
	complexity: number;
	rootFields: Array<{ name: string; uniqueEntryCount: number | null }>;
	oversizedEntryBatch: boolean;
	oversizedLiveExplainBatch: boolean;
	duplicateEntryIds: boolean;
	negativeListLimit: boolean;
} => {
	let maxDepth = depth;
	let aliases = 0;
	let complexity = 0;
	const rootFields: Array<{ name: string; uniqueEntryCount: number | null }> = [];
	let oversizedEntryBatch = false;
	let oversizedLiveExplainBatch = false;
	let duplicateEntryIds = false;
	let negativeListLimit = false;

	for (const selection of selectionSet.selections) {
		if (selection.kind === Kind.FIELD) {
			if (selection.alias) aliases += 1;
			const isIntrospectionField = selection.name.value.startsWith("__");
			const fieldDefinition =
				parentType && (isObjectType(parentType) || isInterfaceType(parentType))
					? parentType.getFields()[selection.name.value]
					: undefined;
			const weight = listWeight(selection.arguments ?? [], variables, fieldDefinition?.args ?? []);
			if (depth === 1) {
				rootFields.push({
					name: selection.name.value,
					uniqueEntryCount: weight.uniqueEntryCount,
				});
			}
			const childMultiplier = multiplier * weight.multiplier;
			const propagateToChildren =
				weight.propagateToChildren &&
				!(depth === 1 && NON_PROPAGATING_LIMIT_ROOTS.has(selection.name.value));
			oversizedEntryBatch ||= weight.oversizedEntryBatch;
			oversizedLiveExplainBatch ||= weight.oversizedLiveExplainBatch;
			duplicateEntryIds ||= weight.duplicateEntryIds;
			negativeListLimit ||= weight.negativeListLimit;
			complexity += childMultiplier;
			// Apollo exposes introspection only outside production, and the
			// graphql-depth-limit validator already treats __ fields as leaves.
			// Mirror that behavior here so development schema verification is not
			// rejected by the independent request guard before Apollo sees it.
			if (isIntrospectionField) continue;
			if (selection.selectionSet) {
				const namedChildType = fieldDefinition ? getNamedType(fieldDefinition.type) : null;
				const child = inspectSelectionSet({
					selectionSet: selection.selectionSet,
					fragments,
					variables,
					depth: depth + 1,
					multiplier: propagateToChildren ? childMultiplier : multiplier,
					seenFragments: new Set(seenFragments),
					schema,
					parentType: asCompositeType(namedChildType),
				});
				maxDepth = Math.max(maxDepth, child.maxDepth);
				aliases += child.aliases;
				complexity += child.complexity;
				oversizedEntryBatch ||= child.oversizedEntryBatch;
				oversizedLiveExplainBatch ||= child.oversizedLiveExplainBatch;
				duplicateEntryIds ||= child.duplicateEntryIds;
				negativeListLimit ||= child.negativeListLimit;
			}
			continue;
		}
		if (selection.kind === Kind.INLINE_FRAGMENT) {
			const fragmentType = selection.typeCondition
				? schema?.getType(selection.typeCondition.name.value)
				: parentType;
			const child = inspectSelectionSet({
				selectionSet: selection.selectionSet,
				fragments,
				variables,
				depth,
				multiplier,
				seenFragments: new Set(seenFragments),
				schema,
				parentType: asCompositeType(fragmentType) ?? parentType,
			});
			maxDepth = Math.max(maxDepth, child.maxDepth);
			aliases += child.aliases;
			complexity += child.complexity;
			oversizedEntryBatch ||= child.oversizedEntryBatch;
			oversizedLiveExplainBatch ||= child.oversizedLiveExplainBatch;
			duplicateEntryIds ||= child.duplicateEntryIds;
			negativeListLimit ||= child.negativeListLimit;
			rootFields.push(...child.rootFields);
			continue;
		}
		const fragmentName = selection.name.value;
		if (seenFragments.has(fragmentName)) continue;
		const fragment = fragments.get(fragmentName);
		if (!fragment) continue;
		const nextSeen = new Set(seenFragments);
		nextSeen.add(fragmentName);
		const fragmentType = schema?.getType(fragment.typeCondition.name.value);
		const child = inspectSelectionSet({
			selectionSet: fragment.selectionSet,
			fragments,
			variables,
			depth,
			multiplier,
			seenFragments: nextSeen,
			schema,
			parentType: asCompositeType(fragmentType) ?? parentType,
		});
		maxDepth = Math.max(maxDepth, child.maxDepth);
		aliases += child.aliases;
		complexity += child.complexity;
		oversizedEntryBatch ||= child.oversizedEntryBatch;
		oversizedLiveExplainBatch ||= child.oversizedLiveExplainBatch;
		duplicateEntryIds ||= child.duplicateEntryIds;
		negativeListLimit ||= child.negativeListLimit;
		rootFields.push(...child.rootFields);
	}

	return {
		maxDepth,
		aliases,
		complexity,
		rootFields,
		oversizedEntryBatch,
		oversizedLiveExplainBatch,
		duplicateEntryIds,
		negativeListLimit,
	};
};

const reject = (
	message: string,
	code:
		| "QUERY_TOO_COMPLEX"
		| "DUPLICATE_ENTRY_IDS"
		| "BATCHING_DISABLED"
		| "INVALID_GRAPHQL_REQUEST" = "QUERY_TOO_COMPLEX"
): GraphQLLimitResult => ({
	ok: false,
	code,
	message,
});

const collectDeprecatedVariableSymbols = (
	value: unknown,
	inputType: GraphQLInputType,
	addSymbol: (symbol: string) => void
): void => {
	if (isNonNullType(inputType)) {
		collectDeprecatedVariableSymbols(value, inputType.ofType, addSymbol);
		return;
	}
	if (value === null || value === undefined) return;
	if (isListType(inputType)) {
		for (const item of Array.isArray(value) ? value : [value]) {
			collectDeprecatedVariableSymbols(item, inputType.ofType, addSymbol);
		}
		return;
	}
	if (isEnumType(inputType)) {
		if (typeof value !== "string") return;
		const enumValue = inputType.getValue(value);
		if (enumValue?.deprecationReason !== undefined) {
			addSymbol(`${inputType.name}.${enumValue.name}`);
		}
		return;
	}
	if (!isInputObjectType(inputType) || typeof value !== "object" || Array.isArray(value)) return;
	const inputValue = value as Record<string, unknown>;
	for (const field of Object.values(inputType.getFields())) {
		// `valueFromASTUntyped` retains an object key whose value is an
		// omitted variable as `undefined`; GraphQL treats that key as absent.
		const supplied = Object.hasOwn(inputValue, field.name) && inputValue[field.name] !== undefined;
		if (!supplied && field.defaultValue === undefined) continue;
		const fieldValue = supplied ? inputValue[field.name] : field.defaultValue;
		if (field.deprecationReason !== undefined) addSymbol(`${inputType.name}.${field.name}`);
		collectDeprecatedVariableSymbols(fieldValue, field.type, addSymbol);
	}
};

const collectDeprecatedSchemaArgumentDefaults = (
	argumentsList: readonly ArgumentNode[] | undefined,
	schemaArguments: readonly GraphQLArgument[],
	variables: Record<string, unknown>,
	variableDefaults: ReadonlyMap<string, unknown>,
	addSymbol: (symbol: string) => void
): void => {
	const suppliedArguments = new Set((argumentsList ?? []).map((argument) => argument.name.value));
	for (const argumentNode of argumentsList ?? []) {
		if (
			argumentNode.value.kind !== Kind.VARIABLE ||
			Object.hasOwn(variables, argumentNode.value.name.value) ||
			variableDefaults.has(argumentNode.value.name.value)
		) {
			continue;
		}
		suppliedArguments.delete(argumentNode.name.value);
	}
	for (const argument of schemaArguments) {
		if (suppliedArguments.has(argument.name) || argument.defaultValue === undefined) continue;
		collectDeprecatedVariableSymbols(argument.defaultValue, argument.type, addSymbol);
	}
};

const collectDeprecatedArgumentValue = (
	argumentNode: ArgumentNode,
	argument: GraphQLArgument | undefined,
	variables: Record<string, unknown>,
	addSymbol: (symbol: string) => void
): void => {
	if (!argument) return;
	collectDeprecatedVariableSymbols(
		valueFromASTUntyped(argumentNode.value, variables),
		argument.type,
		addSymbol
	);
};

const collectDeprecatedArgumentDefaultsAndValues = (
	argumentsList: readonly ArgumentNode[] | undefined,
	schemaArguments: readonly GraphQLArgument[],
	variables: Record<string, unknown>,
	variableDefaults: ReadonlyMap<string, unknown>,
	addSymbol: (symbol: string) => void
): void => {
	collectDeprecatedSchemaArgumentDefaults(
		argumentsList,
		schemaArguments,
		variables,
		variableDefaults,
		addSymbol
	);
	const argumentsByName = new Map(schemaArguments.map((argument) => [argument.name, argument]));
	const effectiveVariables = {
		...Object.fromEntries(variableDefaults),
		...variables,
	};
	for (const argumentNode of argumentsList ?? []) {
		collectDeprecatedArgumentValue(
			argumentNode,
			argumentsByName.get(argumentNode.name.value),
			effectiveVariables,
			addSymbol
		);
	}
};

/*
	The schema can inject defaults before a resolver runs. Walk those effective
	values as well as client-supplied AST nodes so deprecated enum/input values
	used only by a schema default still appear in request telemetry.
*/
const collectDeprecatedFieldDefaults = (
	field: ReturnType<TypeInfo["getFieldDef"]>,
	argumentsList: readonly ArgumentNode[] | undefined,
	variables: Record<string, unknown>,
	variableDefaults: ReadonlyMap<string, unknown>,
	addSymbol: (symbol: string) => void
): void => {
	if (!field) return;
	collectDeprecatedArgumentDefaultsAndValues(
		argumentsList,
		field.args,
		variables,
		variableDefaults,
		addSymbol
	);
};

const executableSelectionIsIncluded = (
	directives: readonly DirectiveNode[] | undefined,
	variables: Record<string, unknown>
): boolean => {
	for (const directive of directives ?? []) {
		if (directive.name.value !== "skip" && directive.name.value !== "include") continue;
		const condition = directive.arguments?.find((argument) => argument.name.value === "if");
		const value = condition ? valueFromASTUntyped(condition.value, variables) : undefined;
		if (directive.name.value === "skip" && value === true) return false;
		if (directive.name.value === "include" && value === false) return false;
	}
	return true;
};

const collectVariableReferences = (
	argumentsList: readonly ArgumentNode[] | undefined,
	usedVariables: Set<string>,
	variableOwners?: Map<string, Set<string | undefined>>,
	owner?: string
): void => {
	for (const argument of argumentsList ?? []) {
		visit(argument.value, {
			Variable(node) {
				usedVariables.add(node.name.value);
				if (variableOwners) {
					const owners = variableOwners.get(node.name.value) ?? new Set<string | undefined>();
					owners.add(owner);
					variableOwners.set(node.name.value, owners);
				}
			},
		});
	}
};

const collectDirectiveVariableReferences = (
	directives: readonly DirectiveNode[] | undefined,
	usedVariables: Set<string>,
	variableOwners?: Map<string, Set<string | undefined>>,
	owner?: string
): void => {
	for (const directive of directives ?? []) {
		collectVariableReferences(directive.arguments, usedVariables, variableOwners, owner);
	}
};

const activeDeprecatedTelemetrySelections = (
	operation: OperationDefinitionNode,
	fragments: ReadonlyMap<string, FragmentDefinitionNode>,
	reachableFragments: ReadonlySet<string>,
	variables: Record<string, unknown>
): {
	fragments: Set<string>;
	variables: Set<string>;
	variableOwners: Map<string, Set<string | undefined>>;
	fragmentDirectiveOwners: Map<string, Set<string>>;
	selectionDirectiveOwners: Map<DirectiveNode, Set<string>>;
} => {
	const active = new Set<string>();
	const usedVariables = new Set<string>();
	const variableOwners = new Map<string, Set<string | undefined>>();
	const fragmentDirectiveOwners = new Map<string, Set<string>>();
	const selectionDirectiveOwners = new Map<DirectiveNode, Set<string>>();
	const analyzedFragments = new Set<string>();
	const fragmentFieldOwnerMemo = new Map<string, Set<string>>();
	const collectFragmentFieldOwners = (
		fragmentName: string,
		seen: ReadonlySet<string> = new Set()
	): Set<string> => {
		if (seen.has(fragmentName)) return new Set();
		const memoized = fragmentFieldOwnerMemo.get(fragmentName);
		if (memoized) return new Set(memoized);
		const fragment = fragments.get(fragmentName);
		if (!fragment) return new Set();
		const nextSeen = new Set(seen);
		nextSeen.add(fragmentName);
		const owners = new Set<string>();
		const collect = (selectionSet: SelectionSetNode): void => {
			for (const selection of selectionSet.selections) {
				if (!executableSelectionIsIncluded(selection.directives, variables)) continue;
				if (selection.kind === Kind.FIELD) {
					if (selection.loc) owners.add(`field:${selection.loc.start}`);
					if (selection.selectionSet) collect(selection.selectionSet);
					continue;
				}
				if (selection.kind === Kind.INLINE_FRAGMENT) {
					collect(selection.selectionSet);
					continue;
				}
				if (nextSeen.has(selection.name.value)) continue;
				for (const owner of collectFragmentFieldOwners(selection.name.value, nextSeen)) {
					owners.add(owner);
				}
			}
		};
		collect(fragment.selectionSet);
		fragmentFieldOwnerMemo.set(fragmentName, new Set(owners));
		return owners;
	};
	const collectSelectionFieldOwners = (
		selectionSet: SelectionSetNode,
		seenFragments: ReadonlySet<string> = new Set()
	): Set<string> => {
		const owners = new Set<string>();
		for (const selection of selectionSet.selections) {
			if (!executableSelectionIsIncluded(selection.directives, variables)) continue;
			if (selection.kind === Kind.FIELD) {
				if (selection.loc) owners.add(`field:${selection.loc.start}`);
				if (selection.selectionSet) {
					for (const owner of collectSelectionFieldOwners(selection.selectionSet, seenFragments)) {
						owners.add(owner);
					}
				}
				continue;
			}
			if (selection.kind === Kind.INLINE_FRAGMENT) {
				for (const owner of collectSelectionFieldOwners(selection.selectionSet, seenFragments)) {
					owners.add(owner);
				}
				continue;
			}
			for (const owner of collectFragmentFieldOwners(selection.name.value, seenFragments)) {
				owners.add(owner);
			}
		}
		return owners;
	};
	const registerSelectionDirectiveOwners = (
		directives: readonly DirectiveNode[] | undefined,
		owners: ReadonlySet<string>
	): void => {
		for (const directive of directives ?? []) {
			const registered = selectionDirectiveOwners.get(directive) ?? new Set<string>();
			for (const owner of owners) registered.add(owner);
			selectionDirectiveOwners.set(directive, registered);
			// A directive on an inline fragment or fragment spread is effective
			// only when one of the fields in that branch executes.
			for (const owner of owners) {
				collectDirectiveVariableReferences([directive], usedVariables, variableOwners, owner);
			}
		}
	};
	const registerFragmentDirectiveOwners = (fragment: FragmentDefinitionNode): void => {
		const owners = collectFragmentFieldOwners(fragment.name.value);
		const registered = fragmentDirectiveOwners.get(fragment.name.value) ?? new Set<string>();
		for (const owner of owners) registered.add(owner);
		fragmentDirectiveOwners.set(fragment.name.value, registered);
		// Variables referenced by a fragment-definition directive are effective
		// only when one of that fragment's field occurrences executes. Keep the
		// variable telemetry on those occurrences instead of making it global.
		for (const owner of owners) {
			collectDirectiveVariableReferences(fragment.directives, usedVariables, variableOwners, owner);
		}
	};
	const inspect = (selectionSet: SelectionSetNode, currentOwner?: string): void => {
		for (const selection of selectionSet.selections) {
			if (!executableSelectionIsIncluded(selection.directives, variables)) continue;
			if (selection.kind === Kind.FIELD) {
				const owner = selection.loc ? `field:${selection.loc.start}` : undefined;
				collectDirectiveVariableReferences(
					selection.directives,
					usedVariables,
					variableOwners,
					owner
				);
				collectVariableReferences(selection.arguments, usedVariables, variableOwners, owner);
				if (selection.selectionSet) inspect(selection.selectionSet, owner);
				continue;
			}
			if (selection.kind === Kind.INLINE_FRAGMENT) {
				registerSelectionDirectiveOwners(
					selection.directives,
					collectSelectionFieldOwners(selection.selectionSet)
				);
				inspect(selection.selectionSet, currentOwner);
				continue;
			}
			const fragmentName = selection.name.value;
			registerSelectionDirectiveOwners(
				selection.directives,
				collectFragmentFieldOwners(fragmentName)
			);
			if (!reachableFragments.has(fragmentName) || analyzedFragments.has(fragmentName)) continue;
			const fragment = fragments.get(fragmentName);
			if (!fragment) continue;
			registerFragmentDirectiveOwners(fragment);
			analyzedFragments.add(fragmentName);
			active.add(fragmentName);
			inspect(fragment.selectionSet);
		}
	};
	inspect(operation.selectionSet);
	collectDirectiveVariableReferences(
		operation.directives,
		usedVariables,
		variableOwners,
		undefined
	);
	return {
		fragments: active,
		variables: usedVariables,
		variableOwners,
		fragmentDirectiveOwners,
		selectionDirectiveOwners,
	};
};

const selectedDeprecatedSymbols = (
	document: ReturnType<typeof analyzeGraphQLOperation>["document"],
	operation: OperationDefinitionNode,
	reachableFragments: ReadonlySet<string>,
	variables: Record<string, unknown>,
	schema?: GraphQLSchema
): {
	symbols: readonly string[];
	owners: Readonly<Record<string, readonly string[]>>;
	globalSymbols: readonly string[];
} => {
	if (!schema) return { symbols: [], owners: {}, globalSymbols: [] };
	const fragments = new Map(
		document.definitions
			.filter(
				(definition): definition is FragmentDefinitionNode =>
					definition.kind === Kind.FRAGMENT_DEFINITION
			)
			.map((fragment) => [fragment.name.value, fragment])
	);
	const activeSelections = activeDeprecatedTelemetrySelections(
		operation,
		fragments,
		reachableFragments,
		variables
	);
	const fragmentDirectiveOwners = new Map<DirectiveNode, ReadonlySet<string>>();
	for (const [fragmentName, owners] of activeSelections.fragmentDirectiveOwners) {
		const fragment = fragments.get(fragmentName);
		if (!fragment) continue;
		for (const directive of fragment.directives ?? []) {
			fragmentDirectiveOwners.set(directive, owners);
		}
	}
	for (const [directive, owners] of activeSelections.selectionDirectiveOwners) {
		fragmentDirectiveOwners.set(directive, owners);
	}
	const selectedDocument = {
		...document,
		definitions: document.definitions.filter(
			(definition) =>
				definition === operation ||
				(definition.kind === Kind.FRAGMENT_DEFINITION &&
					activeSelections.fragments.has(definition.name.value))
		),
	};
	const typeInfo = new TypeInfo(schema);
	const symbols = new Set<string>();
	const owners = new Map<string, Set<string>>();
	const globalSymbols = new Set<string>();
	const fieldOwners: Array<string | undefined> = [];
	const directiveOwnerStack: Array<ReadonlySet<string> | undefined> = [];
	const addSymbol = (symbol: string, owner?: string): void => {
		symbols.add(symbol);
		if (!owner) {
			globalSymbols.add(symbol);
			return;
		}
		const owned = owners.get(owner) ?? new Set<string>();
		owned.add(symbol);
		owners.set(owner, owned);
	};
	const currentFieldOwner = (): string | undefined => fieldOwners.at(-1);
	const addDirectiveSymbol = (
		symbol: string,
		ownersForDirective: ReadonlySet<string> | undefined
	): void => {
		if (ownersForDirective !== undefined) {
			for (const owner of ownersForDirective) addSymbol(symbol, owner);
			return;
		}
		addSymbol(symbol, currentFieldOwner());
	};
	const variableDefaultValueNodes = new WeakSet<ASTNode>();
	const variableDefaults = new Map<string, unknown>();
	for (const definition of operation.variableDefinitions ?? []) {
		if (!definition.defaultValue) continue;
		variableDefaults.set(
			definition.variable.name.value,
			valueFromASTUntyped(definition.defaultValue)
		);
		visit(definition.defaultValue, {
			enter(node) {
				variableDefaultValueNodes.add(node);
			},
		});
	}
	visit(
		selectedDocument,
		visitWithTypeInfo(typeInfo, {
			Field: {
				enter(node) {
					const parentType = typeInfo.getParentType();
					const field = typeInfo.getFieldDef();
					const owner = node.loc
						? `field:${node.loc.start}`
						: parentType && field
							? `${parentType.name}.${field.name}`
							: undefined;
					fieldOwners.push(owner);
					if (!executableSelectionIsIncluded(node.directives, variables)) {
						fieldOwners.pop();
						return false;
					}
					collectDeprecatedFieldDefaults(
						field,
						node.arguments,
						variables,
						variableDefaults,
						(symbol) => addSymbol(symbol, owner)
					);
					if (parentType && field?.deprecationReason !== undefined) {
						addSymbol(`${parentType.name}.${node.name.value}`, owner);
					}
				},
				leave() {
					fieldOwners.pop();
				},
			},
			InlineFragment: {
				enter(node) {
					if (!executableSelectionIsIncluded(node.directives, variables)) return false;
				},
			},
			FragmentSpread: {
				enter(node) {
					if (!executableSelectionIsIncluded(node.directives, variables)) return false;
				},
			},
			Directive: {
				enter(node) {
					const ownersForDirective = fragmentDirectiveOwners.get(node);
					directiveOwnerStack.push(ownersForDirective);
					const directive = schema.getDirective(node.name.value);
					if (!directive) return;
					collectDeprecatedArgumentDefaultsAndValues(
						node.arguments,
						directive.args,
						variables,
						variableDefaults,
						(symbol) => addDirectiveSymbol(symbol, ownersForDirective)
					);
				},
				leave() {
					directiveOwnerStack.pop();
				},
			},
			Argument(node) {
				const parentType = typeInfo.getParentType();
				const field = typeInfo.getFieldDef();
				const argument = typeInfo.getArgument();
				const directive = typeInfo.getDirective();
				if (!directive && parentType && field && argument?.deprecationReason !== undefined) {
					addSymbol(`${parentType.name}.${field.name}(${node.name.value}:)`, currentFieldOwner());
				}
				if (directive && argument?.deprecationReason !== undefined) {
					addDirectiveSymbol(`@${directive.name}(${node.name.value}:)`, directiveOwnerStack.at(-1));
				}
			},
			ObjectField(node) {
				if (variableDefaultValueNodes.has(node)) return;
				if (
					node.value.kind === Kind.VARIABLE &&
					!Object.hasOwn(variables, node.value.name.value) &&
					!variableDefaults.has(node.value.name.value)
				) {
					// An omitted optional variable contributes no input object value;
					// do not report deprecated fields that appear only in its AST
					// shape. Supplied values and operation defaults are handled below.
					return;
				}
				const parentInputType = typeInfo.getParentInputType();
				if (!parentInputType) return;
				const namedParent = getNamedType(parentInputType);
				if (!isInputObjectType(namedParent)) return;
				const field = namedParent.getFields()[node.name.value];
				if (field?.deprecationReason !== undefined) {
					addSymbol(`${namedParent.name}.${field.name}`, currentFieldOwner());
				}
			},
			EnumValue(node) {
				if (variableDefaultValueNodes.has(node)) return;
				const inputType = typeInfo.getInputType();
				const enumValue = typeInfo.getEnumValue();
				if (!inputType || enumValue?.deprecationReason === undefined) return;
				const namedInput = getNamedType(inputType);
				if (isEnumType(namedInput))
					addSymbol(`${namedInput.name}.${enumValue.name}`, currentFieldOwner());
			},
		})
	);
	for (const definition of operation.variableDefinitions ?? []) {
		const variableName = definition.variable.name.value;
		if (!activeSelections.variables.has(variableName)) continue;
		const effectiveValue = Object.hasOwn(variables, variableName)
			? variables[variableName]
			: definition.defaultValue
				? valueFromASTUntyped(definition.defaultValue)
				: undefined;
		const inputType = typeFromAST(schema, definition.type);
		if (inputType && isInputType(inputType)) {
			const ownersForVariable = activeSelections.variableOwners.get(variableName);
			if (ownersForVariable && ownersForVariable.size > 0) {
				collectDeprecatedVariableSymbols(effectiveValue, inputType, (symbol) => {
					for (const owner of ownersForVariable) addSymbol(symbol, owner);
				});
			} else {
				collectDeprecatedVariableSymbols(effectiveValue, inputType, (symbol) => addSymbol(symbol));
			}
		}
	}
	return {
		symbols: [...symbols].sort(),
		owners: Object.fromEntries(
			[...owners.entries()].map(([owner, ownedSymbols]) => [owner, [...ownedSymbols].sort()])
		),
		globalSymbols: [...globalSymbols].sort(),
	};
};

export const ROOT_RATE_LIMIT_FLOORS = new Map<string, number>([
	["liveScores", 5],
	["eventLive", 5],
	["eventLiveExplains", 5],
	["eventOverallResult", 5],
	["playerDetail", 5],
	["playerStateProfile", 5],
	["playerStatsDesk", 5],
	["gameweekDesk", 5],
	["teamSelectionDesk", 5],
	["homePublicBootstrap", 5],
	["homeGameweek", 5],
	["homeMarketPulse", 5],
	["homeMarketDesk", 5],
	["playerStatsBootstrap", 10],
	["homePersonalDesk", 30],
	["briefingWeek", 5],
	["briefingStory", 5],
	["playerValueHistory", 5],
	["marketPulse", 10],
	["marketAvailabilityPage", 5],
	["priceChangeBoard", 10],
	["priceChangeLiveCursor", 1],
	["priceChangeLiveBoard", 10],
	["marketOwnershipOverview", 10],
	["marketOwnershipDay", 10],
	["marketSnapshotContext", 1],
	["playerValues", 5],
	["eventFixtures", 5],
	["currentEventInfo", 1],
	["teams", 2],
	["playersForPicker", 5],
	["miniProgramNotice", 1],
	["publicLeagueTrends", 10],
	["publicLeagueSelectionStats", 10],
	["trendCohorts", 5],
	["trendCohortSnapshot", 10],
	["calcLivePointsByEntry", 10],
	["calcLivePointsForEntries", 10],
	["searchEntries", 10],
	["entryLookup", 5],
	["entryNameUsage", 5],
	["tournamentEventResults", 30],
	["tournamentSelectionStats", 10],
	["tournamentEntryRankingSummary", 10],
	["entryOfficialH2HDesk", 30],
	["tournamentParticipants", 30],
	["tournamentSeasonSnapshot", 30],
	["tournamentOfficialH2H", 30],
	["tournamentDetailDesk", 30],
	["managedTournamentStatus", 2],
	["myFplTeamDesk", 5],
	["myFplTeamGameweek", 5],
	["myFplTeamTransfers", 5],
	["myFplCompetitionsDesk", 10],
	["myFplCompetitionBoard", 10],
	["myFplCompetitionSeasonPath", 5],
	["myFplCompetitionSetupStatus", 5],
]);

export const BOUNDED_PUBLIC_ROOT_RATE_LIMIT_FLOOR = 5;

export const BOUNDED_PUBLIC_DESK_ROOTS: ReadonlySet<string> = new Set([
	"playersForPicker",
	"playerStatsBootstrap",
	"marketAvailabilityPage",
	"marketPulse",
	"priceChangeBoard",
	"priceChangeLiveBoard",
	"marketOwnershipOverview",
	"marketOwnershipDay",
	"marketSnapshotContext",
	"playerValues",
	"eventFixtures",
	"currentEventInfo",
	"teams",
	"miniProgramNotice",
	"entryLookup",
]);

export const effectiveRootRateLimitFloor = (field: string): number =>
	Math.max(
		1,
		ROOT_RATE_LIMIT_FLOORS.get(field) ?? 0,
		BOUNDED_PUBLIC_DESK_ROOTS.has(field) ? BOUNDED_PUBLIC_ROOT_RATE_LIMIT_FLOOR : 0
	);

const heavyRootCost = (
	rootFields: Array<{ name: string; uniqueEntryCount: number | null }>
): number =>
	rootFields.reduce((total, field) => {
		if (field.name === "calcLivePointsForEntries") {
			return total + Math.max(10, field.uniqueEntryCount ?? 0);
		}
		// The effective floor includes bounded-public roots whose registered
		// value is intentionally lower than the work they expose (for example,
		// `teams` is registered at 2 but must cost at least 5).  Use the same
		// effective value for mixed operations as for a bounded-only operation;
		// otherwise adding a cheap sibling root would bypass the bounded floor.
		return total + effectiveRootRateLimitFloor(field.name);
	}, 0);

const accepted = ({
	shape,
	weightedComplexity = 0,
	rootFields = [],
	deprecatedSymbols = [],
	deprecatedSymbolOwners = {},
	deprecatedSymbolGlobalSymbols = [],
}: {
	shape: GraphQLRequestShape;
	weightedComplexity?: number;
	rootFields?: Array<{ name: string; uniqueEntryCount: number | null }>;
	deprecatedSymbols?: readonly string[];
	deprecatedSymbolOwners?: Readonly<Record<string, readonly string[]>>;
	deprecatedSymbolGlobalSymbols?: readonly string[];
}): GraphQLLimitResult => {
	const boundedPublicDeskRequest =
		rootFields.length > 0 && rootFields.every((field) => BOUNDED_PUBLIC_DESK_ROOTS.has(field.name));
	const optimizedMyFplRoots = new Set([
		"myFplTeamDesk",
		"myFplTeamGameweek",
		"myFplTeamTransfers",
		"myFplCompetitionsDesk",
		"myFplCompetitionBoard",
		"myFplCompetitionSeasonPath",
		"myFplCompetitionSetupStatus",
	]);
	const optimizedMyFplRequest =
		rootFields.length > 0 && rootFields.every((field) => optimizedMyFplRoots.has(field.name));
	return {
		ok: true,
		shape,
		weightedComplexity,
		rateLimitCostUnits: boundedPublicDeskRequest
			? Math.max(
					BOUNDED_PUBLIC_ROOT_RATE_LIMIT_FLOOR * rootFields.length,
					heavyRootCost(rootFields)
				)
			: optimizedMyFplRequest
				? heavyRootCost(rootFields)
				: Math.max(1, Math.ceil(weightedComplexity / 10), heavyRootCost(rootFields)),
		rootFields: rootFields.map((field) => field.name),
		deprecatedSymbols,
		deprecatedSymbolOwners,
		deprecatedSymbolGlobalSymbols,
	};
};

export const validateGraphQLPayloadLimits = (
	payload: GraphQLPayload,
	schema?: GraphQLSchema
): GraphQLLimitResult => {
	if (typeof payload.query !== "string") {
		return reject("GraphQL request body must contain a query string", "INVALID_GRAPHQL_REQUEST");
	}

	let analysis: ReturnType<typeof analyzeGraphQLOperation>;
	try {
		analysis = analyzeGraphQLOperation(payload);
	} catch {
		return accepted({ shape: "unknown" });
	}

	const { document, operation, fragments, variables } = analysis;
	const rootInspection = operation
		? effectiveRootFieldsFor(operation, fragments)
		: { fields: [], reachableFragments: new Set<string>() };
	const rootNames = rootInspection.fields;
	const onlyReachableDefinitions =
		operation !== null &&
		document.definitions.every((definition) =>
			definition.kind === Kind.OPERATION_DEFINITION
				? definition === operation
				: definition.kind === Kind.FRAGMENT_DEFINITION
					? rootInspection.reachableFragments.has(definition.name.value)
					: false
		);
	const responseKeys = new Set(rootNames.map((field) => field.responseKey));
	const usesTournamentDetailDesk =
		onlyReachableDefinitions &&
		responseKeys.size === 1 &&
		rootNames.length > 0 &&
		rootNames.every(
			(field) =>
				field.name === "tournamentDetailDesk" && field.responseKey === "tournamentDetailDesk"
		);
	const usesMyFplCompetitionsDesk =
		onlyReachableDefinitions &&
		responseKeys.size === 1 &&
		rootNames.length > 0 &&
		rootNames.every(
			(field) =>
				field.name === "myFplCompetitionsDesk" && field.responseKey === "myFplCompetitionsDesk"
		);
	const usesPlayerStatsDesk =
		onlyReachableDefinitions &&
		responseKeys.size === 1 &&
		rootNames.length > 0 &&
		rootNames.every(
			(field) => field.name === "playerStatsDesk" && field.responseKey === "playerStatsDesk"
		);
	const usesPlayerStateProfile =
		onlyReachableDefinitions &&
		responseKeys.size === 1 &&
		rootNames.length > 0 &&
		rootNames.every(
			(field) => field.name === "playerStateProfile" && field.responseKey === "playerStateProfile"
		);
	const usesCalcLivePointsByEntry =
		onlyReachableDefinitions &&
		responseKeys.size === 1 &&
		rootNames.length > 0 &&
		rootNames.every(
			(field) =>
				field.name === "calcLivePointsByEntry" && field.responseKey === "calcLivePointsByEntry"
		);
	const usesEntryLiveCompetitionBoard =
		onlyReachableDefinitions &&
		responseKeys.size === 1 &&
		rootNames.length > 0 &&
		rootNames.every(
			(field) =>
				field.name === "entryLiveCompetitionBoard" &&
				field.responseKey === "entryLiveCompetitionBoard"
		);
	const maxAstNodes = usesTournamentDetailDesk
		? TOURNAMENT_DETAIL_DESK_MAX_AST_NODES
		: usesMyFplCompetitionsDesk
			? GRAPHQL_LIMITS.maxBoundedDeskAstNodes
			: usesPlayerStatsDesk
				? PLAYER_STATS_DESK_MAX_AST_NODES
				: usesPlayerStateProfile
					? PLAYER_STATE_PROFILE_MAX_AST_NODES
					: usesCalcLivePointsByEntry
						? CALC_LIVE_POINTS_MAX_AST_NODES
						: usesEntryLiveCompetitionBoard
							? ENTRY_LIVE_COMPETITION_BOARD_MAX_AST_NODES
							: GRAPHQL_LIMITS.maxAstNodes;
	let astNodes = 0;
	visit(document, { enter: () => void (astNodes += 1) });
	if (astNodes > maxAstNodes) {
		return reject(`GraphQL document exceeds ${maxAstNodes} AST nodes`);
	}

	if (!operation) {
		return accepted({ shape: "unknown" });
	}
	const deprecatedTelemetry = selectedDeprecatedSymbols(
		document,
		operation,
		rootInspection.reachableFragments,
		variables,
		schema
	);

	const inspection = inspectSelectionSet({
		selectionSet: operation.selectionSet,
		fragments,
		variables,
		depth: 1,
		multiplier: 1,
		seenFragments: new Set(),
		schema,
		parentType:
			operation.operation === "query"
				? (schema?.getQueryType() ?? null)
				: operation.operation === "mutation"
					? (schema?.getMutationType() ?? null)
					: (schema?.getSubscriptionType() ?? null),
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
	if (inspection.negativeListLimit) {
		return reject("GraphQL list limits must not be negative");
	}
	if (inspection.duplicateEntryIds) {
		return reject("GraphQL entryIds must not contain duplicates", "DUPLICATE_ENTRY_IDS");
	}
	if (inspection.oversizedEntryBatch) {
		return reject("GraphQL entryIds batch exceeds 500 entries");
	}
	if (inspection.oversizedLiveExplainBatch) {
		return reject("GraphQL elementIds batch exceeds 15 players");
	}
	if (inspection.complexity > GRAPHQL_LIMITS.maxComplexity) {
		return reject(`GraphQL operation exceeds weighted complexity ${GRAPHQL_LIMITS.maxComplexity}`);
	}

	return accepted({
		shape: operation.operation,
		weightedComplexity: inspection.complexity,
		rootFields: inspection.rootFields,
		deprecatedSymbols: deprecatedTelemetry.symbols,
		deprecatedSymbolOwners: deprecatedTelemetry.owners,
		deprecatedSymbolGlobalSymbols: deprecatedTelemetry.globalSymbols,
	});
};

export const validateGraphQLRequestLimits = (
	body: unknown,
	schema?: GraphQLSchema
): GraphQLLimitResult => {
	if (Array.isArray(body)) {
		return reject("GraphQL request batching is disabled", "BATCHING_DISABLED");
	}
	if (!body || typeof body !== "object") {
		return reject("GraphQL request body must be an object", "INVALID_GRAPHQL_REQUEST");
	}
	const payloads = [body];
	let shape: GraphQLRequestShape = "unknown";
	let weightedComplexity = 0;
	let rateLimitCostUnits = 0;
	const rootFields: string[] = [];
	const deprecatedSymbols = new Set<string>();
	const deprecatedSymbolOwners = new Map<string, Set<string>>();
	const deprecatedSymbolGlobalSymbols = new Set<string>();
	for (const payload of payloads) {
		if (!payload || typeof payload !== "object") {
			return reject("GraphQL request body must be an object", "INVALID_GRAPHQL_REQUEST");
		}
		const result = validateGraphQLPayloadLimits(payload as GraphQLPayload, schema);
		if (!result.ok) return result;
		if (result.shape === "mutation") shape = "mutation";
		else if (shape === "unknown") shape = result.shape;
		weightedComplexity += result.weightedComplexity;
		rateLimitCostUnits += result.rateLimitCostUnits;
		rootFields.push(...result.rootFields);
		for (const symbol of result.deprecatedSymbols) deprecatedSymbols.add(symbol);
		for (const symbol of result.deprecatedSymbolGlobalSymbols) {
			deprecatedSymbolGlobalSymbols.add(symbol);
		}
		for (const [owner, symbols] of Object.entries(result.deprecatedSymbolOwners)) {
			const owned = deprecatedSymbolOwners.get(owner) ?? new Set<string>();
			for (const symbol of symbols) owned.add(symbol);
			deprecatedSymbolOwners.set(owner, owned);
		}
	}
	return {
		ok: true,
		shape,
		weightedComplexity,
		rateLimitCostUnits: Math.max(1, rateLimitCostUnits),
		rootFields,
		deprecatedSymbols: [...deprecatedSymbols].sort(),
		deprecatedSymbolOwners: Object.fromEntries(
			[...deprecatedSymbolOwners.entries()].map(([owner, symbols]) => [owner, [...symbols].sort()])
		),
		deprecatedSymbolGlobalSymbols: [...deprecatedSymbolGlobalSymbols].sort(),
	};
};
