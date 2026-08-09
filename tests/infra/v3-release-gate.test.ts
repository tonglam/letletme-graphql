import { createHash } from "node:crypto";

import { describe, expect, it } from "bun:test";

import {
	decodeV3ReleaseManifest,
	evaluateV3GraphqlReleaseGate,
	type V3GraphqlReleaseGateInput,
	type V3ReleaseManifest,
} from "../../scripts/v3-release-gate";

const runId = "v3-20260808T160008Z-b9eddc0";
const graphqlSha = "2".repeat(40);
const manifest: V3ReleaseManifest = {
	schemaVersion: "v3",
	planVersion: "3.2.5",
	status: "approved",
	cutoverRunId: runId,
	dataSha: "1".repeat(40),
	graphqlSha,
	webSha: "3".repeat(40),
	dataImageDigest: `sha256:${"4".repeat(64)}`,
	graphqlImageDigest: `sha256:${"5".repeat(64)}`,
	approvedAt: "2026-08-10T00:00:00.000Z",
};
const manifestContents = `${JSON.stringify(manifest, null, 2)}\n`;
const manifestSha256 = createHash("sha256").update(manifestContents).digest("hex");

function validInput(overrides: Partial<V3GraphqlReleaseGateInput> = {}): V3GraphqlReleaseGateInput {
	return {
		manifest,
		manifestContents,
		deploySha: graphqlSha,
		deployImageDigest: manifest.graphqlImageDigest ?? undefined,
		cutoverRunId: runId,
		manifestSha256,
		activationApproval: `APPROVE_V3_ACTIVATION ${runId}`,
		...overrides,
	};
}

describe("v3 GraphQL release gate", () => {
	it("accepts the exact approved GraphQL SHA and image digest", () => {
		expect(evaluateV3GraphqlReleaseGate(validInput())).toEqual({
			runId,
			graphqlSha,
			manifestSha256,
		});
	});

	it("decodes only canonical base64 JSON", () => {
		expect(decodeV3ReleaseManifest(Buffer.from(manifestContents).toString("base64"))).toEqual({
			manifest,
			manifestContents,
		});
		for (const encoded of [undefined, "not-base64", "e30"]) {
			expect(() => decodeV3ReleaseManifest(encoded)).toThrow();
		}
	});

	it.each([
		["locked manifest", { manifest: { ...manifest, status: "locked" as const } }],
		["wrong GraphQL SHA", { deploySha: "6".repeat(40) }],
		["wrong GraphQL image", { deployImageDigest: `sha256:${"6".repeat(64)}` }],
		["wrong run", { cutoverRunId: "v3-20260808T160009Z-b9eddc0" }],
		["wrong manifest digest", { manifestSha256: "7".repeat(64) }],
		["missing approval", { activationApproval: undefined }],
	])("blocks %s", (_name, overrides) => {
		expect(() => evaluateV3GraphqlReleaseGate(validInput(overrides))).toThrow();
	});
});
