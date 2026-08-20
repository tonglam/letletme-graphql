import { describe, expect, test } from "bun:test";

const ref = (await Bun.file(".github/data-platform-contract-ref").text()).trim();
const workflow = await Bun.file(".github/workflows/ci.yml").text();
const securityWorkflow = await Bun.file(".github/workflows/security.yml").text();

describe("Data Platform contract pin", () => {
	test("uses a fixed full SHA for required CI", () => {
		expect(ref).toMatch(/^[0-9a-f]{40}$/);
		expect(workflow).toContain(".github/data-platform-contract-ref");
		expect(workflow).toContain("ref: ${{ steps.data-contract.outputs.ref }}");
	});

	test("checks fixed SHA drift against Data main only in scheduled security", () => {
		expect(securityWorkflow).toContain("repos/tonglam/letletme_data/commits/main");
		expect(securityWorkflow).toContain("fixed Data SHA:");
		expect(securityWorkflow).toContain("Data main SHA:");
		expect(securityWorkflow).toContain("contract-drift:");
	});
});
