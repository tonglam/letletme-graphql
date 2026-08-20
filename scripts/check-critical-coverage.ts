import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type CriticalCoverageThreshold = {
	lines: number;
	functions: number;
};

export type CriticalCoverageResult = {
	linesFound: number;
	linesHit: number;
	functionsFound: number;
	functionsHit: number;
	errors: string[];
};

export const criticalCoverageTargets = new Map<string, CriticalCoverageThreshold>([
	["src/domains/my-fpl/repository.ts", { lines: 80, functions: 75 }],
	["src/domains/my-fpl/resolvers.ts", { lines: 80, functions: 75 }],
]);

type CoverageTotals = {
	/** Raw LCOV totals are retained for the required non-zero guard. */
	rawLinesFound: number;
	rawFunctionsFound: number;
	/** Bun emits DA records only for executable statements. */
	lineData: Map<number, number>;
	functionsHit: number;
};

const normalizePath = (value: string): string => value.replaceAll("\\", "/");

const parseNumber = (value: string, field: string, file: string): number => {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new Error(`Invalid ${field} value for ${file}: ${value}`);
	}
	return parsed;
};

const targetForFile = (
	file: string,
	targets: Map<string, CriticalCoverageThreshold>
): string | null => {
	for (const target of targets.keys()) {
		if (file === target || file.endsWith(`/${target}`)) return target;
	}
	return null;
};

const parseTotals = (
	content: string,
	targets: Map<string, CriticalCoverageThreshold>
): Map<string, CoverageTotals> => {
	const totals = new Map<string, CoverageTotals>();
	let currentFile: string | null = null;
	for (const line of content.split(/\r?\n/)) {
		if (line.startsWith("SF:")) {
			currentFile = normalizePath(line.slice(3));
			continue;
		}
		if (line === "end_of_record") {
			currentFile = null;
			continue;
		}
		if (!currentFile) continue;
		const target = targetForFile(currentFile, targets);
		if (!target) continue;
		const current = totals.get(target) ?? {
			rawLinesFound: 0,
			rawFunctionsFound: 0,
			lineData: new Map<number, number>(),
			functionsHit: 0,
		};
		if (line.startsWith("LF:"))
			current.rawLinesFound = parseNumber(line.slice(3), "LF", currentFile);
		if (line.startsWith("FNF:"))
			current.rawFunctionsFound = parseNumber(line.slice(4), "FNF", currentFile);
		if (line.startsWith("FNH:"))
			current.functionsHit = parseNumber(line.slice(4), "FNH", currentFile);
		if (line.startsWith("DA:")) {
			const [lineNumber, hitCount] = line.slice(3).split(",", 2);
			if (hitCount === undefined) throw new Error(`Invalid DA value for ${currentFile}: ${line}`);
			const parsedLineNumber = parseNumber(lineNumber, "DA line", currentFile);
			const parsedHitCount = parseNumber(hitCount, "DA hit count", currentFile);
			current.lineData.set(parsedLineNumber, parsedHitCount);
		}
		totals.set(target, current);
	}
	return totals;
};

/**
 * Inspect a Bun LCOV document. Bun's LF includes physical source lines, while
 * DA records identify the executable lines used by its coverage table; use DA
 * for the percentage and retain LF/FNF as a missing/zero-file guard.
 */
export const inspectCriticalCoverage = (
	content: string,
	targets: Map<string, CriticalCoverageThreshold> = criticalCoverageTargets
): Map<string, CriticalCoverageResult> => {
	const totals = parseTotals(content, targets);
	const results = new Map<string, CriticalCoverageResult>();
	for (const [target, threshold] of targets) {
		const value = totals.get(target);
		if (!value) {
			results.set(target, {
				linesFound: 0,
				linesHit: 0,
				functionsFound: 0,
				functionsHit: 0,
				errors: [`Missing LCOV record for ${target}`],
			});
			continue;
		}
		const linesFound = value.lineData.size;
		const linesHit = [...value.lineData.values()].filter((count) => count > 0).length;
		const functionsFound = value.rawFunctionsFound;
		const errors: string[] = [];
		if (value.rawLinesFound === 0 || functionsFound === 0 || linesFound === 0) {
			errors.push(`LCOV totals are zero for ${target}`);
		}
		const linesPercent = linesFound === 0 ? 0 : (linesHit / linesFound) * 100;
		const functionsPercent = functionsFound === 0 ? 0 : (value.functionsHit / functionsFound) * 100;
		if (linesPercent < threshold.lines || functionsPercent < threshold.functions) {
			errors.push(
				`${target} is below the required lines ${threshold.lines}% / functions ${threshold.functions}% thresholds`
			);
		}
		results.set(target, {
			linesFound,
			linesHit,
			functionsFound,
			functionsHit: value.functionsHit,
			errors,
		});
	}
	return results;
};

const main = (): void => {
	const coveragePath = resolve(process.argv[2] ?? "coverage/lcov.info");
	const results = inspectCriticalCoverage(readFileSync(coveragePath, "utf8"));
	let failed = false;
	for (const [target, result] of results) {
		const linesPercent = result.linesFound === 0 ? 0 : (result.linesHit / result.linesFound) * 100;
		const functionsPercent =
			result.functionsFound === 0 ? 0 : (result.functionsHit / result.functionsFound) * 100;
		console.log(
			`${target}: lines ${linesPercent.toFixed(2)}% (${result.linesHit}/${result.linesFound}), functions ${functionsPercent.toFixed(2)}% (${result.functionsHit}/${result.functionsFound})`
		);
		for (const error of result.errors) console.error(error);
		if (result.errors.length > 0) failed = true;
	}
	if (failed) process.exitCode = 1;
};

if (import.meta.main) main();
