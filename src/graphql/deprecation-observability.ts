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
}: {
	symbols: readonly string[];
	symbolOwners?: Readonly<Record<string, readonly string[]>>;
	globalSymbols?: readonly string[];
	increment: (symbol: string) => void;
	onExecutionEnd?: () => void;
}): GraphQLRequestExecutionListener<TContext> => {
	let committed = false;
	let executedField = false;
	const ownedSymbols = new Set(Object.values(symbolOwners).flat());
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
		async executionDidEnd(): Promise<void> {
			if (!committed && executedField) {
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
