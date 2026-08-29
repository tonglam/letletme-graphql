// One connection is enough for the Redis-first live hot path.  The second
// slot is reserved for bounded checkpoint reads and low-frequency metadata.
const DEFAULT_DATABASE_POOL_MAX = 2;

export function parseDatabasePoolMax(raw: string | undefined): number {
	if (raw === undefined || raw.trim() === "") {
		return DEFAULT_DATABASE_POOL_MAX;
	}
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1 || value > 2) {
		throw new Error("DATABASE_POOL_MAX must be an integer between 1 and 2");
	}
	return value;
}
