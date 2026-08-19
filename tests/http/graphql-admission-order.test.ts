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
});
