export const LIVE_MATCHES_CONTRACT_HEADER = "X-LetLetMe-Contract";
export const LIVE_MATCHES_CONTRACT_VALUE = "live-matches-v2";

const LIVE_MATCHES_ROOT_FIELDS = new Set(["liveMatchday"]);

export const isLiveMatchesRootField = (field: string): boolean =>
	LIVE_MATCHES_ROOT_FIELDS.has(field);

export const requiresLiveMatchesV2Contract = (rootFields: readonly string[]): boolean =>
	rootFields.some(isLiveMatchesRootField);

export const hasLiveMatchesV2Contract = (headers: Headers): boolean =>
	headers.get(LIVE_MATCHES_CONTRACT_HEADER) === LIVE_MATCHES_CONTRACT_VALUE;
