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

export const parseBooleanEnv = (
	raw: string | undefined,
	key: string,
	fallback: boolean
): boolean => {
	if (raw === undefined || raw.trim() === "") return fallback;
	const normalized = raw.trim().toLowerCase();
	if (normalized === "true") return true;
	if (normalized === "false") return false;
	throw new Error(`${key} must be true or false`);
};

export const parseFullFieldLiveBoardEnabled = (raw: string | undefined): boolean => {
	if (raw === undefined || raw.trim() === "") return true;
	const normalized = raw.trim().toLowerCase();
	if (["true", "1", "yes", "on"].includes(normalized)) return true;
	if (["false", "0", "no", "off"].includes(normalized)) return false;
	throw new Error(
		"FULL_FIELD_LIVE_BOARD_ENABLED must be one of true, false, 1, 0, yes, no, on, or off"
	);
};
