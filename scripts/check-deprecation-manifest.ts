import { readFile } from "node:fs/promises";

type DeprecationItem = {
	id?: unknown;
	symbol?: unknown;
	owner?: unknown;
	introducedAt?: unknown;
	removedAt?: unknown;
	removalTarget?: unknown;
	status?: unknown;
	usageMetric?: unknown;
};

const isCanonicalDate = (value: unknown): value is string => {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const parsed = new Date(`${value}T00:00:00.000Z`);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

export const validateDeprecationManifest = (
	value: unknown,
	today = new Date().toISOString().slice(0, 10)
): string[] => {
	if (!Array.isArray(value)) return ["Deprecation manifest must be an array"];
	const ids = new Set<string>();
	const errors: string[] = [];
	for (const [index, item] of value.entries()) {
		const row = item as DeprecationItem;
		const id = typeof row.id === "string" ? row.id : `index-${index}`;
		if (ids.has(id)) errors.push(`duplicate id: ${id}`);
		ids.add(id);
		for (const key of ["id", "symbol", "owner", "introducedAt", "status", "usageMetric"] as const) {
			if (typeof row[key] !== "string" || row[key] === "") errors.push(`${id}: missing ${key}`);
		}
		if (!isCanonicalDate(row.introducedAt)) errors.push(`${id}: introducedAt must be YYYY-MM-DD`);
		if (row.status !== "deprecated" && row.status !== "removed") {
			errors.push(`${id}: status must be deprecated or removed`);
			continue;
		}
		if (row.status === "deprecated") {
			if (!isCanonicalDate(row.removalTarget)) {
				errors.push(`${id}: removalTarget must be YYYY-MM-DD`);
			} else if (row.removalTarget <= today) {
				errors.push(`${id}: removalTarget has expired`);
			}
		}
		if (row.status === "removed" && !isCanonicalDate(row.removedAt)) {
			errors.push(`${id}: removedAt must be YYYY-MM-DD`);
		}
	}
	return errors;
};

if (import.meta.main) {
	const manifestUrl = new URL("../documentation/deprecation-manifest.json", import.meta.url);
	const raw = await readFile(manifestUrl, "utf8");
	const value = JSON.parse(raw) as unknown;
	const errors = validateDeprecationManifest(value);
	if (errors.length > 0) {
		console.error(errors.join("\n"));
		process.exit(1);
	}
	console.log(`Deprecation manifest OK (${(value as unknown[]).length} entries)`);
}
