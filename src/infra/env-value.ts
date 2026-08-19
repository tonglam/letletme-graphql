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

export const parseBoundedPositiveIntegerEnv = (
	raw: string | undefined,
	key: string,
	fallback: number,
	minimum: number,
	maximum: number
): number => {
	const value = parsePositiveIntegerEnv(raw, key, fallback);
	if (value < minimum || value > maximum) {
		throw new Error(`${key} must be between ${minimum} and ${maximum}`);
	}
	return value;
};
