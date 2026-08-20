import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";

const source = readFileSync(new URL("../../scripts/rate-limit-load.ts", import.meta.url), "utf8");

describe("GraphQL v3 capacity model", () => {
	it("encodes the exact 300-concurrent traffic mix and staged run", () => {
		expect(source).toContain("length: 180");
		expect(source).toContain("length: 60");
		expect(source).toContain("length: 45");
		expect(source).toContain("length: 15");
		expect(source).toContain("Math.round(concurrent * 0.6)");
		expect(source).toContain("Math.round(concurrent * 0.2)");
		expect(source).toContain("Math.round(concurrent * 0.15)");
		expect(source).toContain("[50, stageSeconds]");
		expect(source).toContain("[100, stageSeconds]");
		expect(source).toContain("[200, stageSeconds]");
		expect(source).toContain("[300, finalStageSeconds]");
	});

	it("gates latency, non-429 errors, health, pool waiting, resources, and isolation", () => {
		for (const gate of [
			"normal429Zero",
			"global429Zero",
			"pageRequestsSuccessful",
			"non429ErrorRateBelowPointOnePercent",
			"graphQLP95Below800Ms",
			"graphQLP99Below2s",
			"postgresPoolWaitingZero",
			"healthAlwaysReady",
			"dependencyHealthAlwaysReady",
			"cpuBelow80Percent",
			"memoryBelow85Percent",
			"attackerWasIsolated",
		]) {
			expect(source).toContain(gate);
		}
		expect(source).toContain("graphql_request_outcomes_total");
		expect(source).toContain("serverNon429ErrorRate");
		expect(source).toContain("Math.max(directNon429ErrorRate, serverNon429ErrorRate)");
		expect(source).toContain("sustainableRpsHeadroomProven");
		expect(source).toContain("natPeersUnaffected");
		expect(source).toContain("natPeerWouldDenied");
		expect(source).toContain("shadowIsolationAttributable");
		expect(source).toContain("attackerWasIsolated: attackerWouldDenied > 0");
		expect(source).not.toContain("attackerWasIsolated: attacker429 > 0");
		expect(source).toContain("X-Letletme-Capacity-Run");
		expect(source).toContain("sample.status < 200 || sample.status >= 300");
		expect(source).toContain("if (!result.passed) break");
	});

	it("derives sustainable RPS from passing probes without a manual profile override", () => {
		expect(source).toContain("sustainability.filter((phase) => phase.passed)");
		const profileSource = readFileSync(
			new URL("../../scripts/generate-rate-limit-profile.ts", import.meta.url),
			"utf8"
		);
		expect(profileSource).not.toContain("--sustainable-rps");
	});

	it("never serializes session cookies or signing secrets into the report", () => {
		const report = source.slice(source.indexOf("const report ="));
		expect(report).not.toContain("sessionCookies");
		expect(report).not.toContain("backendSecret");
		expect(report).not.toContain("serviceToken");
		expect(report).not.toContain("metricsToken");
	});
});
