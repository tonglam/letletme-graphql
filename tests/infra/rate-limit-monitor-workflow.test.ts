import { describe, expect, test } from "bun:test";

const workflow = await Bun.file(".github/workflows/rate-limit-monitor.yml").text();

describe("rate-limit monitor workflow", () => {
	test("runs every five minutes with privacy-safe aggregate gates", () => {
		expect(workflow).toContain('cron: "*/5 * * * *"');
		expect(workflow).toContain(
			"rate-limit:report --days 2 --recent-minutes 10 --include-live-storage-failures --json"
		);
		expect(workflow).toContain(".recent.summary.totalDecisions > 0");
		expect(workflow).toContain(".live.rateLimitStorageFailures == 0");
		expect(workflow).toContain('.mode == "shadow-v3" and .recent.summary.shadowDecisions > 0');
		expect(workflow).toContain('.mode == "enforce-v3" and .recent.summary.enforcedDecisions > 0');
		expect(workflow).toContain('.mode == "shadow-v4" and .policy == "graphql-v4"');
		expect(workflow).toContain("miniWorkloadShadowDeniedRate");
		expect(workflow).toContain('miniWorkloadShadowDenied["player-stats"] == 0');
		expect(workflow).toContain('.mode == "enforce-v4"');
		expect(workflow).toContain("miniWorkloadDeniedRate");
		expect(workflow).toContain('miniWorkloadDenied["player-stats"] == 0');
		expect(workflow).toContain(".recent.summary.interactiveDeniedRate <= 0.01");
		expect(workflow).toContain(".recent.summary.shadowInteractiveDeniedRate <= 0.01");
		expect(workflow).toContain(".recent.summary.globalDenied == 0");
		expect(workflow).toContain(".recent.summary.globalWouldDenied == 0");
		expect(workflow).not.toContain("GRAPHQL_ENV");
	});

	test("retains a bounded non-sensitive report artifact", () => {
		expect(workflow).toContain("actions/upload-artifact@");
		expect(workflow).toContain("retention-days: 14");
		expect(workflow).toContain("rate-limit-report.json");
	});
});
