import type { GraphQLResolveInfo } from "graphql";

/**
 * Additive, read-side evidence attached to a business payload.  The type is
 * deliberately independent from Data's ops tables: GraphQL can only claim a
 * complete response when the publication/checkpoint that produced the
 * payload supplies a coherent revision and counts.
 */
export type DataEligibilityState = "ELIGIBLE" | "NOT_APPLICABLE" | "INVALID";

export type DataCompletenessMeta = {
	contractKey: string;
	scopeKey: string;
	revision: string | null;
	sourceCheckedAt: string | null;
	expectedCount: number | null;
	observedCount: number | null;
	complete: boolean;
	eligibility: DataEligibilityState;
};

type CompletenessInput = {
	contractKey: string;
	scopeKey: string;
	revision?: string | number | null;
	sourceCheckedAt?: string | Date | null;
	expectedCount?: number | null;
	observedCount?: number | null;
	complete?: boolean;
	eligibility?: DataEligibilityState;
	/**
	 * Optional second revision from the business payload.  A mismatch is
	 * fail-closed: the response remains readable while the
	 * metadata cannot claim completeness.
	 */
	payloadRevision?: string | number | null;
};

const normalizeRevision = (value: string | number | null | undefined): string | null => {
	if (value === null || value === undefined) return null;
	const revision = String(value).trim();
	return revision.length > 0 ? revision : null;
};

const normalizeTimestamp = (value: string | Date | null | undefined): string | null => {
	if (value === null || value === undefined) return null;
	const parsed = value instanceof Date ? value : new Date(value);
	return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
};

const normalizeCount = (value: number | null | undefined): number | null =>
	value !== null && value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : null;

export const revisionsAgree = (
	metadataRevision: string | number | null | undefined,
	payloadRevision: string | number | null | undefined
): boolean => {
	const metadata = normalizeRevision(metadataRevision);
	const payload = normalizeRevision(payloadRevision);
	return metadata !== null && payload !== null && metadata === payload;
};

export const buildDataCompleteness = (input: CompletenessInput): DataCompletenessMeta => {
	const revision = normalizeRevision(input.revision);
	const payloadRevision =
		input.payloadRevision === undefined ? revision : normalizeRevision(input.payloadRevision);
	const expectedCount = normalizeCount(input.expectedCount);
	const observedCount = normalizeCount(input.observedCount);
	const countsAgree =
		expectedCount !== null && observedCount !== null && expectedCount === observedCount;
	const countsSupplied = expectedCount !== null || observedCount !== null;
	const revisionOk = revisionsAgree(revision, payloadRevision);
	const eligibility = input.eligibility ?? "ELIGIBLE";
	const requestedComplete = input.complete ?? (countsAgree || !countsSupplied);
	const complete =
		eligibility === "ELIGIBLE" &&
		revisionOk &&
		(!countsSupplied || countsAgree) &&
		requestedComplete;
	return Object.freeze({
		contractKey: input.contractKey,
		scopeKey: input.scopeKey,
		revision,
		sourceCheckedAt: normalizeTimestamp(input.sourceCheckedAt),
		expectedCount,
		observedCount,
		complete,
		eligibility: revisionOk ? eligibility : "INVALID",
	});
};

export const unavailableDataCompleteness = (
	contractKey: string,
	scopeKey: string,
	eligibility: DataEligibilityState = "INVALID"
): DataCompletenessMeta =>
	buildDataCompleteness({ contractKey, scopeKey, eligibility, revision: null, complete: false });

/** Keep resolver modules from accidentally treating a GraphQL selection as an authority check. */
export const completenessWasRequested = (info: GraphQLResolveInfo): boolean =>
	info.fieldNodes.some((node) =>
		node.selectionSet?.selections.some(
			(selection) => selection.kind === "Field" && selection.name.value === "completeness"
		)
	);

export const dataCompletenessTypeDefs = /* GraphQL */ `
	enum DataEligibilityState {
		ELIGIBLE
		NOT_APPLICABLE
		INVALID
	}

	type DataCompletenessMeta {
		contractKey: String!
		scopeKey: String!
		revision: String
		sourceCheckedAt: DateTime
		expectedCount: Int
		observedCount: Int
		complete: Boolean!
		eligibility: DataEligibilityState!
	}
`;
