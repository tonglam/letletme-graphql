import { describe, expect, it } from "bun:test";
import {
	inspectCriticalCoverage,
	type CriticalCoverageThreshold,
} from "../../scripts/check-critical-coverage";

const targets = new Map<string, CriticalCoverageThreshold>([
	["src/domains/my-fpl/repository.ts", { lines: 80, functions: 75 }],
	["src/domains/my-fpl/resolvers.ts", { lines: 80, functions: 75 }],
]);

describe("critical coverage LCOV parser", () => {
	it("uses executable DA records and normalizes absolute Windows paths", () => {
		const lcov = `TN:
SF:C:\\workspace\\src\\domains\\my-fpl\\repository.ts
FNF:4
FNH:3
DA:10,2
DA:11,0
LF:99
LH:80
end_of_record
SF:/workspace/src/domains/my-fpl/resolvers.ts
FNF:2
FNH:2
DA:20,1
DA:21,1
LF:90
LH:90
end_of_record`;

		const result = inspectCriticalCoverage(lcov, targets);
		expect(result.get("src/domains/my-fpl/repository.ts")).toEqual({
			linesFound: 2,
			linesHit: 1,
			functionsFound: 4,
			functionsHit: 3,
			errors: [
				"src/domains/my-fpl/repository.ts is below the required lines 80% / functions 75% thresholds",
			],
		});
		expect(result.get("src/domains/my-fpl/resolvers.ts")?.errors).toEqual([]);
	});

	it("fails closed when a target record is absent", () => {
		const lcov = `TN:
SF:src/domains/my-fpl/repository.ts
FNF:1
FNH:1
DA:1,1
LF:1
LH:1
end_of_record`;

		const result = inspectCriticalCoverage(lcov, targets);
		expect(result.get("src/domains/my-fpl/resolvers.ts")?.errors).toEqual([
			"Missing LCOV record for src/domains/my-fpl/resolvers.ts",
		]);
	});
});
