export type LivePublicationFailureReason =
	"LIVE_PUBLICATION_UNAVAILABLE" | "LIVE_SNAPSHOT_LOAD_FAILED";

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

/** Collapse internal snapshot errors into a bounded, log-safe reason. */
export const livePublicationFailureReason = (error: unknown): LivePublicationFailureReason => {
	const message = error instanceof Error ? error.message : "";
	return message.startsWith("LIVE_PUBLICATION_UNAVAILABLE:")
		? "LIVE_PUBLICATION_UNAVAILABLE"
		: "LIVE_SNAPSHOT_LOAD_FAILED";
};
