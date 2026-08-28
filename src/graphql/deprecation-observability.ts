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
	increment,
	onExecutionEnd,
}: {
	symbols: readonly string[];
	increment: (symbol: string) => void;
	onExecutionEnd?: () => void;
}): GraphQLRequestExecutionListener<TContext> => {
	let committed = false;
	return {
		...(symbols.length > 0
			? {
					willResolveField(): void {
						if (committed) return;
						committed = true;
						recordDeprecatedSchemaUsages({ symbols, increment });
					},
				}
			: {}),
		async executionDidEnd(): Promise<void> {
			onExecutionEnd?.();
		},
	};
};
