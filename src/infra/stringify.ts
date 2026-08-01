/**
 * Deterministic JSON serialisation for use in cache keys.
 * Object keys are sorted so that { a:1, b:2 } and { b:2, a:1 } produce
 * the same string.
 */
export const stableStringify = (value: unknown): string => {
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	if (typeof value === "object" && value !== null) {
		const keys = Object.keys(value as Record<string, unknown>).sort();
		const entries = keys.map(
			(key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`
		);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value);
};
