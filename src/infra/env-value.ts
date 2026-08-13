export const parsePositiveIntegerEnv = (
	raw: string | undefined,
	key: string,
	fallback: number
): number => {
	const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`${key} must be a positive integer`);
	}
	return value;
};
