import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
	scriptKindForSourceFile,
	isTypeScriptSourceFile,
	moduleSpecifiers,
	resolveSourceModule,
} from "../../scripts/check-layer-dependencies";

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

test("layer checker recognizes dynamic imports with import options", () => {
	const sourceFile = ts.createSourceFile(
		"fixture.ts",
		'const service = import("../domains/entries/service", { with: {} });',
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS
	);
	expect(moduleSpecifiers(sourceFile).map(({ value }) => value)).toEqual([
		"../domains/entries/service",
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

test("layer checker rejects nonliteral dynamic module specifiers", () => {
	const sourceFile = ts.createSourceFile(
		"fixture.ts",
		'const target = "../domains/entries/service"; import(target); require(target);',
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS
	);
	expect(moduleSpecifiers(sourceFile)).toEqual([
		{ value: "", line: 1, dynamic: true },
		{ value: "", line: 1, dynamic: true },
	]);
});

test("layer checker rejects createRequire loaders in checked layers", () => {
	const sourceFile = ts.createSourceFile(
		"fixture.ts",
		'import { createRequire as makeRequire } from "node:module"; const load = makeRequire(import.meta.url); load("../domains/entries/service");',
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS
	);
	expect(moduleSpecifiers(sourceFile)).toContainEqual({ value: "", line: 1, dynamic: true });
});

test("layer checker rejects CommonJS createRequire destructuring loaders", () => {
	const sourceFile = ts.createSourceFile(
		"fixture.ts",
		'const { createRequire: makeRequire } = require("node:module"); const load = makeRequire(import.meta.url);',
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS
	);
	expect(moduleSpecifiers(sourceFile)).toContainEqual({ value: "", line: 1, dynamic: true });
});

test("layer checker finds createRequire bindings nested inside functions", () => {
	const sourceFile = ts.createSourceFile(
		"fixture.ts",
		'function loadService() { const { createRequire: makeRequire } = require("node:module"); return makeRequire(import.meta.url); }',
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS
	);
	expect(moduleSpecifiers(sourceFile)).toContainEqual({ value: "", line: 1, dynamic: true });
});

test("layer checker does not treat an unrelated local createRequire function as a loader", () => {
	const sourceFile = ts.createSourceFile(
		"fixture.ts",
		'function createRequire(path: string) { return path; } const load = createRequire("../domains/entries/service");',
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS
	);
	expect(moduleSpecifiers(sourceFile)).toEqual([]);
});

test("layer checker inspects CommonJS module.require calls", () => {
	const sourceFile = ts.createSourceFile(
		"fixture.cts",
		'module.require("../domains/entries/service"); module.require(target);',
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS
	);
	expect(moduleSpecifiers(sourceFile)).toEqual([
		{ value: "../domains/entries/service", line: 1 },
		{ value: "", line: 1, dynamic: true },
	]);
});

test("layer checker finds createRequire aliases from dynamic node:module imports", () => {
	const sourceFile = ts.createSourceFile(
		"fixture.ts",
		'async function loadService() { const { createRequire: makeRequire } = await import("node:module"); return makeRequire(import.meta.url); }',
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS
	);
	expect(moduleSpecifiers(sourceFile)).toContainEqual({ value: "", line: 1, dynamic: true });
});

test("layer checker recognizes relative module augmentations", () => {
	const sourceFile = ts.createSourceFile(
		"fixture.ts",
		'declare module "../domains/entries/service" { export type Marker = string; }',
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS
	);
	expect(moduleSpecifiers(sourceFile).map(({ value }) => value)).toEqual([
		"../domains/entries/service",
	]);
});

test("layer checker recognizes triple-slash path references", () => {
	const sourceFile = ts.createSourceFile(
		"fixture.ts",
		'/// <reference path="../domains/entries/service.ts" />',
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS
	);
	expect(moduleSpecifiers(sourceFile).map(({ value }) => value)).toEqual([
		"../domains/entries/service.ts",
	]);
});

test("layer checker recognizes triple-slash type references", () => {
	const sourceFile = ts.createSourceFile(
		"fixture.ts",
		'/// <reference types="../domains/entries/service" />',
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS
	);
	expect(moduleSpecifiers(sourceFile).map(({ value }) => value)).toEqual([
		"../domains/entries/service",
	]);
});

test("layer checker parses TSX with the TSX script kind", () => {
	const sourceFile = ts.createSourceFile(
		"fixture.tsx",
		'const View = () => <div>{import("../domains/entries/service")}</div>;',
		ts.ScriptTarget.Latest,
		true,
		scriptKindForSourceFile("fixture.tsx")
	);
	expect(moduleSpecifiers(sourceFile).map(({ value }) => value)).toEqual([
		"../domains/entries/service",
	]);
});

test("layer checker includes every TypeScript module extension", () => {
	expect(isTypeScriptSourceFile("src/infra/runtime.ts")).toBe(true);
	expect(isTypeScriptSourceFile("src/infra/runtime.tsx")).toBe(true);
	expect(isTypeScriptSourceFile("src/infra/runtime.mts")).toBe(true);
	expect(isTypeScriptSourceFile("src/infra/runtime.cts")).toBe(true);
	expect(isTypeScriptSourceFile("src/infra/runtime.js")).toBe(false);
});
