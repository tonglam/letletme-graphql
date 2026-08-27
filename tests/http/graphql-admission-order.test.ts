import { describe, expect, it } from "bun:test";
import {
	GRAPHQL_ADMISSION_STAGES,
	GraphQLAdmissionOrder,
} from "../../src/http/graphql-admission-order";
import type { TokenBucketStageResultV3 } from "../../src/http/token-bucket-v3";

const { mergeShadowRateLimitDecision, selectTerminalRateLimitDecision } =
	await import("../../src/http/graphql-admission-decision");

const decision = (
	allowed: boolean,
	scope: "global" | "client" | "workload"
): TokenBucketStageResultV3 => ({
	allowed,
	retryAfterSeconds: allowed ? 0 : 1,
	...(allowed ? {} : { deniedScope: scope, deniedBucketId: `${scope}-bucket` }),
	details: [
		{
			id: `${scope}-bucket`,
			scope,
			cost: 1,
			refillPerSecond: 1,
			burst: 1,
			remainingMilliTokens: allowed ? 1_000 : 0,
		},
	],
});

describe("GraphQL admission ordering", () => {
	it("allows the complete security sequence in the declared order", () => {
		const order = new GraphQLAdmissionOrder();
		for (const stage of GRAPHQL_ADMISSION_STAGES) order.enter(stage);
		expect(order.completedStages()).toEqual(GRAPHQL_ADMISSION_STAGES);
	});

	it("rejects skipped, repeated, and reordered admission stages", () => {
		const skipped = new GraphQLAdmissionOrder();
		expect(() => skipped.enter("principal")).toThrow("expected pre-auth");

		const repeated = new GraphQLAdmissionOrder();
		repeated.enter("pre-auth");
		expect(() => repeated.enter("pre-auth")).toThrow("expected body-read");

		const weightedBeforeAuth = new GraphQLAdmissionOrder();
		for (const stage of ["pre-auth", "body-read", "transport", "principal"] as const) {
			weightedBeforeAuth.enter(stage);
		}
		expect(() => weightedBeforeAuth.enter("weighted")).toThrow("expected authentication");
	});

	it("keeps a pre-auth shadow denial terminal even after weighted admission allows", () => {
		const preAuthDenial = decision(false, "global");
		const weightedAllow = decision(true, "client");

		expect(selectTerminalRateLimitDecision(preAuthDenial, weightedAllow)).toBe(preAuthDenial);
		expect(
			mergeShadowRateLimitDecision(mergeShadowRateLimitDecision(null, preAuthDenial), weightedAllow)
		).toEqual({ outcome: "deny", scope: "global" });
	});
});
