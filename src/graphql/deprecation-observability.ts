import type { BaseContext, GraphQLRequestExecutionListener } from "@apollo/server";

export type DeprecationResponsePathSegment = string | number;

/**
 * A response-path segment that records the runtime object type for a
 * conditional selection. GraphQL response keys cannot contain a colon, so the
 * marker cannot collide with an actual response key.
 */
export const deprecationTypeOwnerSegment = (typeName: string): string => `__type:${typeName}`;

/**
 * Convert a GraphQL response path into a stable owner key. List indexes are
 * intentionally omitted because one fragment occurrence can execute once per
 * item; response object keys still distinguish separate branches/aliases.
 */
export const deprecationPathOwner = (path: readonly DeprecationResponsePathSegment[]): string =>
	`path:${path.filter((segment): segment is string => typeof segment === "string").join(".")}`;

const MAX_RUNTIME_TYPE_OWNER_VARIANTS = 128;

export const recordDeprecatedSchemaUsages = ({
	symbols,
	increment,
}: {
	symbols: readonly string[];
	increment: (symbol: string) => void;
}): number => {
	const uniqueSymbols = [...new Set(symbols)].sort();
	for (const symbol of uniqueSymbols) increment(symbol);
	return uniqueSymbols.length;
};

export const createDeprecatedSchemaUsageExecutionListener = <TContext extends BaseContext>({
	symbols,
	symbolOwners = {},
	globalSymbols,
	increment,
	onExecutionEnd,
	isExecutionSuccessful,
}: {
	symbols: readonly string[];
	symbolOwners?: Readonly<Record<string, readonly string[]>>;
	globalSymbols?: readonly string[];
	increment: (symbol: string) => void;
	onExecutionEnd?: () => void;
	isExecutionSuccessful?: () => boolean;
}): GraphQLRequestExecutionListener<TContext> => {
	let committed = false;
	let executedField = false;
	const ownedSymbols = new Set(Object.values(symbolOwners).flat());
	const hasExplicitGlobalSymbols = globalSymbols !== undefined;
	const effectiveGlobalSymbols =
		globalSymbols ?? symbols.filter((symbol) => !ownedSymbols.has(symbol));
	const executedOwners = new Set<string>();
	const runtimeTypesByParentPath = new Map<string, Set<string>>();
	const addRuntimePathOwners = (path: readonly DeprecationResponsePathSegment[]): void => {
		const responsePath = path.filter((segment): segment is string => typeof segment === "string");
		let generatedVariants = 0;
		const visitPath = (index: number, output: string[]): void => {
			if (generatedVariants >= MAX_RUNTIME_TYPE_OWNER_VARIANTS) return;
			if (index === responsePath.length) {
				if (output.some((segment) => segment.startsWith("__type:"))) {
					executedOwners.add(deprecationPathOwner(output));
					generatedVariants += 1;
				}
				return;
			}
			const prefixOwner = deprecationPathOwner(responsePath.slice(0, index));
			const runtimeTypes = runtimeTypesByParentPath.get(prefixOwner);
			if (!runtimeTypes || runtimeTypes.size === 0) {
				visitPath(index + 1, [...output, responsePath[index]]);
				return;
			}
			// Keep the unannotated owner as well: a conditional branch may begin
			// deeper in the response path, and ordinary field ownership must remain
			// stable when no branch marker is present at this prefix.
			visitPath(index + 1, [...output, responsePath[index]]);
			for (const typeName of [...runtimeTypes].sort()) {
				visitPath(index + 1, [
					...output,
					deprecationTypeOwnerSegment(typeName),
					responsePath[index],
				]);
			}
		};
		visitPath(0, []);
	};
	return {
		...(symbols.length > 0
			? {
					willResolveField({ info }): void {
						executedField = true;
						for (const fieldNode of info.fieldNodes) {
							if (fieldNode.loc) executedOwners.add(`field:${fieldNode.loc.start}`);
						}
						const path: DeprecationResponsePathSegment[] = [];
						for (
							let current: typeof info.path | undefined = info.path;
							current;
							current = current.prev
						) {
							path.push(current.key);
						}
						const responsePath = path.reverse();
						const parentPathOwner = deprecationPathOwner(responsePath.slice(0, -1));
						const runtimeTypes = runtimeTypesByParentPath.get(parentPathOwner) ?? new Set<string>();
						runtimeTypes.add(info.parentType.name);
						runtimeTypesByParentPath.set(parentPathOwner, runtimeTypes);
						executedOwners.add(deprecationPathOwner(responsePath));
						addRuntimePathOwners(responsePath);
						executedOwners.add(`${info.parentType.name}.${info.fieldName}`);
					},
				}
			: {}),
		async executionDidEnd(error?: Error): Promise<void> {
			// A successful operation may execute no resolver (for example, every
			// field is excluded by an @skip directive) but still use a deprecated
			// operation-level/directive symbol. Commit global symbols in that case;
			// field-owned symbols remain gated on an actually executed field.
			if (
				!error &&
				!committed &&
				(executedField ||
					(hasExplicitGlobalSymbols &&
						effectiveGlobalSymbols.length > 0 &&
						(isExecutionSuccessful?.() ?? true)))
			) {
				const executedSymbols = new Set(effectiveGlobalSymbols);
				for (const owner of executedOwners) {
					for (const symbol of symbolOwners[owner] ?? []) executedSymbols.add(symbol);
				}
				recordDeprecatedSchemaUsages({ symbols: [...executedSymbols], increment });
				committed = true;
			}
			onExecutionEnd?.();
		},
	};
};
