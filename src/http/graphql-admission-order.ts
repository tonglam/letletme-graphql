export const GRAPHQL_ADMISSION_STAGES = [
	"pre-auth",
	"body-read",
	"transport",
	"principal",
	"authentication",
	"weighted",
	"authorization",
] as const;

export type GraphQLAdmissionStage = (typeof GRAPHQL_ADMISSION_STAGES)[number];

/**
 * Runtime invariant for the security-sensitive GraphQL admission sequence.
 * Early exits may stop at any stage, but a request that continues cannot skip,
 * repeat, or reorder principal verification, weighted admission, and authz.
 */
export class GraphQLAdmissionOrder {
	private nextStageIndex = 0;

	enter(stage: GraphQLAdmissionStage): void {
		const expected = GRAPHQL_ADMISSION_STAGES[this.nextStageIndex];
		if (stage !== expected) {
			throw new Error(
				`Invalid GraphQL admission order: expected ${expected ?? "completion"}, received ${stage}`
			);
		}
		this.nextStageIndex += 1;
	}

	completedStages(): readonly GraphQLAdmissionStage[] {
		return GRAPHQL_ADMISSION_STAGES.slice(0, this.nextStageIndex);
	}
}
