import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { moduleSpecifiers, resolveSourceModule } from "../../scripts/check-layer-dependencies";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

test("layer checker applies TypeScript extension substitution to ESM .js imports", () => {
	const resolved = resolveSourceModule(
		resolve(repositoryRoot, "src/infra/env.ts"),
		"../domains/entries/service.js"
	);
	expect(resolved).toBe(resolve(repositoryRoot, "src/domains/entries/service.ts"));
});

test("layer checker recognizes static template literals in dynamic imports and require calls", () => {
	const sourceFile = ts.createSourceFile(
		"fixture.ts",
		"const service = import(`../domains/entries/service`); const legacy = require(`../index`);",
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS
	);
	expect(moduleSpecifiers(sourceFile).map(({ value }) => value)).toEqual([
		"../domains/entries/service",
		"../index",
	]);
});

test("layer checker recognizes TypeScript import-type expressions", () => {
	const sourceFile = ts.createSourceFile(
		"fixture.ts",
		'type Service = import("../domains/entries/service").Service; type Entrypoint = typeof import("../index");',
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS
	);
	expect(moduleSpecifiers(sourceFile).map(({ value }) => value)).toEqual([
		"../domains/entries/service",
		"../index",
	]);
});
