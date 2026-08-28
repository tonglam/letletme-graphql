import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
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

test("layer checker includes every TypeScript module extension", () => {
	expect(isTypeScriptSourceFile("src/infra/runtime.ts")).toBe(true);
	expect(isTypeScriptSourceFile("src/infra/runtime.tsx")).toBe(true);
	expect(isTypeScriptSourceFile("src/infra/runtime.mts")).toBe(true);
	expect(isTypeScriptSourceFile("src/infra/runtime.cts")).toBe(true);
	expect(isTypeScriptSourceFile("src/infra/runtime.js")).toBe(false);
});
