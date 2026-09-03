import { describe, expect, it } from "bun:test";
import { classifyGraphQLIngress } from "../../src/infra/ingress-context";
import {
	isLiveMatchCapacityAdmission,
	LIVE_MATCH_CAPACITY_USER_AGENT_PREFIX,
} from "../../src/http/live-match-capacity-admission";
import {
	LIVE_MATCHES_CONTRACT_HEADER,
	LIVE_MATCHES_CONTRACT_VALUE,
} from "../../src/http/live-matches-contract";

const serviceIngress = classifyGraphQLIngress(new Headers(), {
	ingressContext: null,
	serviceTokenValid: true,
});

const signedIngress = classifyGraphQLIngress(new Headers(), {
	ingressContext: {
		version: 2,
		subject: "a".repeat(64),
		abuseSubject: null,
		trafficClass: "web_rsc",
		workload: "fixtures",
	},
	serviceTokenValid: false,
});

const capacityHeaders = (overrides: Record<string, string> = {}): Headers =>
	new Headers({
		[LIVE_MATCHES_CONTRACT_HEADER]: LIVE_MATCHES_CONTRACT_VALUE,
		"user-agent": `${LIVE_MATCH_CAPACITY_USER_AGENT_PREFIX}cap-head-test`,
		"x-metrics-token": "capacity-metrics-token",
		...overrides,
	});

const matchingToken = (provided: string | undefined): boolean =>
	provided === "capacity-metrics-token";

describe("live-match capacity admission", () => {
	it("admits only the service-token capacity probe with a matching metrics token", () => {
		expect(isLiveMatchCapacityAdmission(capacityHeaders(), serviceIngress, matchingToken)).toBe(
			true
		);
	});

	it("rejects signed public ingress even when capacity headers are present", () => {
		expect(isLiveMatchCapacityAdmission(capacityHeaders(), signedIngress, matchingToken)).toBe(
			false
		);
	});

	it("rejects a missing or mismatched metrics token", () => {
		expect(
			isLiveMatchCapacityAdmission(
				capacityHeaders({ "x-metrics-token": "wrong-token-value" }),
				serviceIngress,
				matchingToken
			)
		).toBe(false);
		const headers = capacityHeaders();
		headers.delete("x-metrics-token");
		expect(isLiveMatchCapacityAdmission(headers, serviceIngress, matchingToken)).toBe(false);
	});

	it("rejects probes without the live-matches V3 contract or capacity user-agent", () => {
		expect(
			isLiveMatchCapacityAdmission(
				capacityHeaders({ [LIVE_MATCHES_CONTRACT_HEADER]: "live-matches-v2" }),
				serviceIngress,
				matchingToken
			)
		).toBe(false);
		expect(
			isLiveMatchCapacityAdmission(
				capacityHeaders({ "user-agent": "curl/8.0" }),
				serviceIngress,
				matchingToken
			)
		).toBe(false);
	});
});
