export const LIVE_MATCHES_CONTRACT_HEADER = "X-LetLetMe-Contract";
export const LIVE_MATCHES_CONTRACT_VALUE = "live-matches-v2";

const LIVE_MATCHES_ROOT_FIELDS = new Set(["liveMatchday"]);
const LIVE_MATCHES_HOT_PATH_SAFE_COMPANION_ROOT_FIELDS = new Set([
	"_empty",
	"__typename",
	"__schema",
	"__type",
]);

export const isLiveMatchesRootField = (field: string): boolean =>
	LIVE_MATCHES_ROOT_FIELDS.has(field);

export const requiresLiveMatchesV2Contract = (rootFields: readonly string[]): boolean =>
	rootFields.some(isLiveMatchesRootField);

export const isLiveMatchesHotPathOperation = (rootFields: readonly string[]): boolean =>
	rootFields.some(isLiveMatchesRootField) &&
	rootFields.every(
		(field) =>
			isLiveMatchesRootField(field) || LIVE_MATCHES_HOT_PATH_SAFE_COMPANION_ROOT_FIELDS.has(field)
	);

export const hasLiveMatchesV2Contract = (headers: Headers): boolean =>
	(headers.get(LIVE_MATCHES_CONTRACT_HEADER) ?? "")
		.split(",")
		.map((token) => token.trim())
		.includes(LIVE_MATCHES_CONTRACT_VALUE);
