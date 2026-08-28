import type { BaseContext, GraphQLRequestExecutionListener } from "@apollo/server";

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
	return {
		...(symbols.length > 0
			? {
					willResolveField({ info }): void {
						executedField = true;
						for (const fieldNode of info.fieldNodes) {
							if (fieldNode.loc) executedOwners.add(`field:${fieldNode.loc.start}`);
						}
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
