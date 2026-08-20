import { describe, expect, test } from "bun:test";

const workflow = await Bun.file(".github/workflows/rate-limit-monitor.yml").text();

describe("rate-limit monitor workflow", () => {
	test("runs every five minutes with privacy-safe aggregate gates", () => {
		expect(workflow).toContain('cron: "*/5 * * * *"');
		expect(workflow).toContain("rate-limit:report --days 2 --json");
		expect(workflow).toContain(".summary.interactiveDeniedRate <= 0.01");
		expect(workflow).toContain(".summary.shadowInteractiveDeniedRate <= 0.01");
		expect(workflow).toContain(".summary.globalDenied == 0");
		expect(workflow).toContain(".summary.globalWouldDenied == 0");
		expect(workflow).not.toContain("GRAPHQL_ENV");
	});

	test("retains a bounded non-sensitive report artifact", () => {
		expect(workflow).toContain("actions/upload-artifact@");
		expect(workflow).toContain("retention-days: 14");
		expect(workflow).toContain("rate-limit-report.json");
	});
});
