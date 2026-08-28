import { readFile } from "node:fs/promises";
import {
	isEnumType,
	isInputObjectType,
	isInterfaceType,
	isObjectType,
	type GraphQLSchema,
} from "graphql";

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
	const symbols = new Set<string>();
	const errors: string[] = [];
	for (const [index, item] of value.entries()) {
		const row = item as DeprecationItem;
		const id = typeof row.id === "string" ? row.id : `index-${index}`;
		if (ids.has(id)) errors.push(`duplicate id: ${id}`);
		ids.add(id);
		if (typeof row.symbol === "string") {
			if (symbols.has(row.symbol)) errors.push(`duplicate symbol: ${row.symbol}`);
			symbols.add(row.symbol);
		}
		for (const key of ["id", "symbol", "owner", "introducedAt", "status", "usageMetric"] as const) {
			if (typeof row[key] !== "string" || row[key] === "") errors.push(`${id}: missing ${key}`);
		}
		if (!isCanonicalDate(row.introducedAt)) {
			errors.push(`${id}: introducedAt must be YYYY-MM-DD`);
		} else if (row.introducedAt > today) {
			errors.push(`${id}: introducedAt cannot be in the future`);
		}
		if (row.status !== "deprecated" && row.status !== "removed") {
			errors.push(`${id}: status must be deprecated or removed`);
			continue;
		}
		if (row.status === "deprecated") {
			if (!isCanonicalDate(row.removalTarget)) {
				errors.push(`${id}: removalTarget must be YYYY-MM-DD`);
			} else if (row.removalTarget <= today) {
				errors.push(`${id}: removalTarget has expired`);
			} else if (isCanonicalDate(row.introducedAt) && row.removalTarget <= row.introducedAt) {
				errors.push(`${id}: removalTarget must be after introducedAt`);
			}
		}
		if (row.status === "removed") {
			if (!isCanonicalDate(row.removedAt)) {
				errors.push(`${id}: removedAt must be YYYY-MM-DD`);
			} else {
				if (row.removedAt > today) errors.push(`${id}: removedAt cannot be in the future`);
				if (isCanonicalDate(row.introducedAt) && row.removedAt < row.introducedAt) {
					errors.push(`${id}: removedAt cannot predate introducedAt`);
				}
			}
		}
	}
	return errors;
};

export const deprecatedSchemaUsageMetric = (symbol: string): string =>
	`graphql_deprecated_schema_usages_total{symbol="${symbol}"}`;

const collectExecutableSchemaSymbols = (
	schema: GraphQLSchema,
	deprecatedOnly: boolean
): readonly string[] => {
	const symbols = new Set<string>();
	for (const type of Object.values(schema.getTypeMap())) {
		if (type.name.startsWith("__")) continue;
		if (isObjectType(type) || isInterfaceType(type)) {
			for (const field of Object.values(type.getFields())) {
				const fieldSymbol = `${type.name}.${field.name}`;
				if (!deprecatedOnly || field.deprecationReason !== undefined) symbols.add(fieldSymbol);
				for (const argument of field.args) {
					if (!deprecatedOnly || argument.deprecationReason !== undefined) {
						symbols.add(`${fieldSymbol}(${argument.name}:)`);
					}
				}
			}
			continue;
		}
		if (isInputObjectType(type)) {
			for (const field of Object.values(type.getFields())) {
				if (!deprecatedOnly || field.deprecationReason !== undefined) {
					symbols.add(`${type.name}.${field.name}`);
				}
			}
			continue;
		}
		if (isEnumType(type)) {
			for (const value of type.getValues()) {
				if (!deprecatedOnly || value.deprecationReason !== undefined) {
					symbols.add(`${type.name}.${value.name}`);
				}
			}
		}
	}
	for (const directive of schema.getDirectives()) {
		for (const argument of directive.args) {
			if (!deprecatedOnly || argument.deprecationReason !== undefined) {
				symbols.add(`@${directive.name}(${argument.name}:)`);
			}
		}
	}
	return [...symbols].sort();
};

export const executableSchemaSymbols = (schema: GraphQLSchema): readonly string[] =>
	collectExecutableSchemaSymbols(schema, false);

export const deprecatedSchemaSymbols = (schema: GraphQLSchema): readonly string[] =>
	collectExecutableSchemaSymbols(schema, true);

export const validateSchemaDeprecationCoverage = (
	value: unknown,
	schema: GraphQLSchema
): readonly string[] => {
	if (!Array.isArray(value)) return ["Deprecation manifest must be an array"];
	const errors: string[] = [];
	const rowsBySymbol = new Map<string, DeprecationItem[]>();
	for (const item of value) {
		const row = item as DeprecationItem;
		if (typeof row.symbol !== "string") continue;
		const rows = rowsBySymbol.get(row.symbol) ?? [];
		rows.push(row);
		rowsBySymbol.set(row.symbol, rows);
	}
	const schemaSymbols = new Set(deprecatedSchemaSymbols(schema));
	const executableSymbols = new Set(executableSchemaSymbols(schema));
	for (const symbol of schemaSymbols) {
		const rows = rowsBySymbol.get(symbol) ?? [];
		if (rows.length === 0) {
			errors.push(`missing schema deprecation: ${symbol}`);
			continue;
		}
		if (rows.length > 1) errors.push(`duplicate schema deprecation: ${symbol}`);
		const row = rows[0];
		const id = typeof row.id === "string" ? row.id : symbol;
		if (row.status !== "deprecated") {
			errors.push(`${id}: executable schema deprecation must have deprecated status`);
		}
		const expectedMetric = deprecatedSchemaUsageMetric(symbol);
		if (row.usageMetric !== expectedMetric) {
			errors.push(`${id}: usageMetric must be ${expectedMetric}`);
		}
	}
	for (const [symbol, rows] of rowsBySymbol) {
		for (const row of rows) {
			if (row.status === "removed" && executableSymbols.has(symbol)) {
				const id = typeof row.id === "string" ? row.id : symbol;
				errors.push(`${id}: removed symbol is present in the executable schema`);
			}
			if (row.status === "deprecated" && !schemaSymbols.has(symbol)) {
				const id = typeof row.id === "string" ? row.id : symbol;
				errors.push(`${id}: deprecated symbol is not in the executable schema`);
			}
		}
	}
	return errors;
};

if (import.meta.main) {
	const manifestUrl = new URL("../documentation/deprecation-manifest.json", import.meta.url);
	const raw = await readFile(manifestUrl, "utf8");
	const value = JSON.parse(raw) as unknown;
	const { schema } = await import("../src/graphql/schema");
	const errors = [
		...validateDeprecationManifest(value),
		...validateSchemaDeprecationCoverage(value, schema),
	];
	if (errors.length > 0) {
		console.error(errors.join("\n"));
		process.exit(1);
	}
	console.log(`Deprecation manifest OK (${(value as unknown[]).length} entries)`);
}
