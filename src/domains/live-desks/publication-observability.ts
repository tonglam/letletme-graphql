export type LivePublicationFailureReason =
	"LIVE_PUBLICATION_UNAVAILABLE" | "LIVE_SNAPSHOT_LOAD_FAILED";

export type LivePublicationFailureDetails = {
	reason: LivePublicationFailureReason;
	revision: string | null;
};

const loggedPublicationFailures = new WeakMap<object, Set<string>>();

/** Keep aliased fixture-player fields from logging the same failed snapshot repeatedly. */
export const claimLivePublicationFailureLog = (
	requestScope: object,
	eventId: number,
	revision: string | null
): boolean => {
	let failures = loggedPublicationFailures.get(requestScope);
	if (!failures) {
		failures = new Set();
		loggedPublicationFailures.set(requestScope, failures);
	}
	const key = `${eventId}:${revision ?? "latest"}`;
	if (failures.has(key)) return false;
	failures.add(key);
	return true;
};

/** Extract only the strict server-generated publication identity used by diagnostics. */
export const livePublicationFailureDetails = (
	error: unknown,
	season: string,
	eventId: number
): LivePublicationFailureDetails => {
	const message = error instanceof Error ? error.message : "";
	const match = message.match(
		/^LIVE_PUBLICATION_UNAVAILABLE:(\d{4}):([1-9]\d{0,2}):(none|[1-9]\d{0,18})$/
	);
	if (!match || match[1] !== season || Number(match[2]) !== eventId) {
		return { reason: "LIVE_SNAPSHOT_LOAD_FAILED", revision: null };
	}
	return {
		reason: "LIVE_PUBLICATION_UNAVAILABLE",
		revision: match[3] === "none" ? null : match[3]!,
	};
};
