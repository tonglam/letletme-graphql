import { readFileSync } from "fs";
import { describe, expect, it } from "bun:test";

describe("GraphQL admission ordering", () => {
	it("parses and validates the operation before one combined admission", () => {
		const source = readFileSync("src/index.ts", "utf8");
		const bodyRead = source.indexOf('"bodyRead"');
		const requestLimits = source.indexOf('"requestLimits"');
		const principal = source.indexOf('"principal"');
		const invalidAuth = source.indexOf("hasAuthenticationMaterial(request.headers)");
		const admission = source.indexOf('"admission"');
		const authorization = source.indexOf('"authorization"');

		expect(bodyRead).toBeLessThan(principal);
		expect(requestLimits).toBeLessThan(principal);
		expect(principal).toBeLessThan(invalidAuth);
		expect(invalidAuth).toBeLessThan(admission);
		expect(admission).toBeLessThan(authorization);
		expect(source.match(/enforceGraphQLRateLimits\(/g)?.length).toBe(1);
		expect(source).not.toContain('"preAuthAdmission"');
		expect(source).not.toContain('"principalAdmission"');
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
});
