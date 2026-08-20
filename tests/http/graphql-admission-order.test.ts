import { readFileSync } from "fs";
import { describe, expect, it } from "bun:test";

describe("GraphQL admission ordering", () => {
	it("protects principal verification before complexity-weighted admission", () => {
		const source = readFileSync("src/index.ts", "utf8");
		const preAuth = source.indexOf('"preAuthAdmission"');
		const bodyRead = source.indexOf('"bodyRead"');
		const transport = source.indexOf("const transportFailure");
		const principal = source.indexOf('"principal"');
		const invalidAuth = source.indexOf("hasAuthenticationMaterial(request.headers)");
		const principalAdmission = source.indexOf('"principalAdmission"');
		const authorization = source.indexOf('"authorization"');

		expect(preAuth).toBeGreaterThan(-1);
		expect(preAuth).toBeLessThan(bodyRead);
		expect(bodyRead).toBeLessThan(principal);
		expect(transport).toBeGreaterThan(bodyRead);
		expect(transport).toBeLessThan(principal);
		expect(principal).toBeLessThan(invalidAuth);
		expect(invalidAuth).toBeLessThan(principalAdmission);
		expect(principalAdmission).toBeLessThan(authorization);
	});

	it("logs normalized operation names and stage timings without principal identifiers", () => {
		const source = readFileSync("src/index.ts", "utf8");
		const timingPayload = source.slice(
			source.indexOf("const finalizeGraphQLResponse"),
			source.indexOf("try {", source.indexOf("const finalizeGraphQLResponse"))
		);
		expect(timingPayload).toContain("operationName");
		expect(timingPayload).toContain("requestTiming.snapshot()");
		expect(timingPayload).not.toContain("userId");
		expect(timingPayload).not.toContain("principal:");
	});

	it("persists the v3 shadow outcome before a legacy rejection can return", () => {
		const source = readFileSync("src/index.ts", "utf8");
		const decisionBlock = source.indexOf("if (principalAdmissionResult.v3Decision)");
		const aggregate = source.indexOf("await recordTerminalRequestV3Outcome", decisionBlock);
		const earlyResponse = source.indexOf("if (principalAdmissionResult.response)", decisionBlock);

		expect(decisionBlock).toBeGreaterThan(-1);
		expect(aggregate).toBeGreaterThan(decisionBlock);
		expect(aggregate).toBeLessThan(earlyResponse);
		expect(source).toContain("shadowLegacyPreAuthResponse = preAuthAdmission.response");
		expect(source).toContain("shadowSkipLegacy: shadowLegacyPreAuthResponse !== null");
		expect(source).toContain("v3Checks: v3PrincipalAdmission.checks");
		expect(source).toContain("graphQLV3EarlyFailureRateLimitChecks");
		expect(source).toContain('"earlyFailureAdmission"');
		expect(source).toContain('"X-RateLimit-Shadow-Outcome"');
		expect(source).toContain("captureShadowRateLimitDecision");
		expect(source).toContain('shadowRateLimitDecision?.outcome === "deny"');
	});

	it("keeps a Mini pre-auth shadow denial as the request aggregate outcome", () => {
		const source = readFileSync("src/index.ts", "utf8");
		const terminalCapture = source.indexOf("terminalPreAuthV3Denial = preAuthAdmission.v3Decision");
		const terminalSelector = source.indexOf("terminalPreAuthV3Denial ?? fallbackDecision");
		const weightedAdmission = source.indexOf('"principalAdmission"');

		expect(terminalCapture).toBeGreaterThan(-1);
		expect(terminalCapture).toBeLessThan(weightedAdmission);
		expect(terminalSelector).toBeGreaterThan(-1);
		expect(source.match(/recordTerminalRequestV3Outcome\(/g)?.length).toBe(3);
		expect(source).toContain("if (v3AggregateRecorded) return");
	});
});
