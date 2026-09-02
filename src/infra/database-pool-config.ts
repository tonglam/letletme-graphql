// The Redis-first live hot path needs one connection.  Additional slots serve
// concurrent checkpoint reads, metadata queries, and the myFplManagerGameweek
// review-context + snapshot-entry fan-out that runs under a single request.
const DEFAULT_DATABASE_POOL_MAX = 4;

export function parseDatabasePoolMax(raw: string | undefined): number {
	if (raw === undefined || raw.trim() === "") {
		return DEFAULT_DATABASE_POOL_MAX;
	}
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1 || value > 4) {
		throw new Error("DATABASE_POOL_MAX must be an integer between 1 and 4");
	}
	return value;
}
