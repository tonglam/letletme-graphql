const DEFAULT_DATABASE_POOL_MAX = 5;

export function parseDatabasePoolMax(raw: string | undefined): number {
	if (raw === undefined || raw.trim() === "") {
		return DEFAULT_DATABASE_POOL_MAX;
	}
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1 || value > 10) {
		throw new Error("DATABASE_POOL_MAX must be an integer between 1 and 10");
	}
	return value;
}
