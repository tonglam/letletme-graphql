export const recordDeprecatedSchemaUsages = ({
	validationErrors,
	symbols,
	increment,
}: {
	validationErrors?: readonly Error[];
	symbols: readonly string[];
	increment: (symbol: string) => void;
}): number => {
	if (validationErrors && validationErrors.length > 0) return 0;
	const uniqueSymbols = [...new Set(symbols)].sort();
	for (const symbol of uniqueSymbols) increment(symbol);
	return uniqueSymbols.length;
};
