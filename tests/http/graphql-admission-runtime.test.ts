import { describe, expect, it } from "bun:test";

import { rateLimitStorageFailureShouldFailClosed } from "../../src/http/graphql-admission-runtime";

describe("GraphQL rate-limit storage failure policy", () => {
	it("fails open for observational shadow buckets", () => {
		expect(
			rateLimitStorageFailureShouldFailClosed({
				checks: [{ scope: "client" }],
				enforce: false,
			})
		).toBe(false);
	});

	it("keeps enforced and global emergency buckets fail closed", () => {
		expect(
			rateLimitStorageFailureShouldFailClosed({
				checks: [{ scope: "client" }],
				enforce: true,
			})
		).toBe(true);
		expect(
			rateLimitStorageFailureShouldFailClosed({
				checks: [{ scope: "global" }],
				enforce: false,
			})
		).toBe(true);
	});
});
