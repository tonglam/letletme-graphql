import { readFileSync, readdirSync } from "node:fs";
import { extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import ts from "typescript";

const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
const sourceRoot = join(repositoryRoot, "src");
const checkedRoots = [join(sourceRoot, "infra"), join(sourceRoot, "http")];
const forbiddenRoots = [join(sourceRoot, "domains"), join(sourceRoot, "index.ts")];
const tsconfigPath = join(repositoryRoot, "tsconfig.json");
const tsconfig = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
if (tsconfig.error) {
	throw new Error(ts.flattenDiagnosticMessageText(tsconfig.error.messageText, "\n"));
}
const compilerOptions = ts.parseJsonConfigFileContent(
	tsconfig.config,
	ts.sys,
	repositoryRoot,
	undefined,
	tsconfigPath
).options;

export const TYPESCRIPT_SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
export const isTypeScriptSourceFile = (file: string): boolean =>
	TYPESCRIPT_SOURCE_EXTENSIONS.has(extname(file));

const sourceFilesUnder = (directory: string): string[] => {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const file = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...sourceFilesUnder(file));
		else if (entry.isFile() && isTypeScriptSourceFile(file)) files.push(file);
	}
	return files;
};

export const moduleSpecifiers = (
	sourceFile: ts.SourceFile
): Array<{ value: string; line: number }> => {
	const modules: Array<{ value: string; line: number }> = [];
	const add = (node: ts.Node, value: string): void => {
		if (value.startsWith(".")) {
			const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
			modules.push({ value, line });
		}
	};
	ts.forEachChild(sourceFile, function visit(node): void {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
			if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
				add(node.moduleSpecifier, node.moduleSpecifier.text);
			}
		}
		if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
			const expression = node.moduleReference.expression;
			if (expression && ts.isStringLiteralLike(expression)) add(expression, expression.text);
		}
		if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
			const literal = node.argument.literal;
			if (ts.isStringLiteralLike(literal)) add(literal, literal.text);
		}
		if (ts.isCallExpression(node)) {
			const expression = node.expression;
			if (
				(ts.isIdentifier(expression) && expression.text === "require") ||
				// Dynamic import may carry a second import-options argument. The
				// module specifier is still always its first argument, so inspect it
				// regardless of the options object's presence.
				(expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length >= 1)
			) {
				const argument = node.arguments[0];
				if (argument && ts.isStringLiteralLike(argument)) add(argument, argument.text);
			}
		}
		ts.forEachChild(node, visit);
	});
	return modules;
};

export const resolveSourceModule = (fromFile: string, specifier: string): string | null =>
	ts.resolveModuleName(specifier, fromFile, compilerOptions, ts.sys).resolvedModule
		?.resolvedFileName ?? null;

const under = (file: string, root: string): boolean => {
	const path = normalize(relative(root, file));
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

export const collectLayerDependencyFindings = (): string[] => {
	const findings: string[] = [];
	for (const root of checkedRoots) {
		for (const file of sourceFilesUnder(root)) {
			const source = readFileSync(file, "utf8");
			const sourceFile = ts.createSourceFile(
				file,
				source,
				ts.ScriptTarget.Latest,
				true,
				ts.ScriptKind.TS
			);
			for (const { value, line } of moduleSpecifiers(sourceFile)) {
				const target = resolveSourceModule(file, value);
				if (!target) continue;
				const forbidden = forbiddenRoots.find((root) => under(target, root));
				if (forbidden) {
					findings.push(
						`${relative(repositoryRoot, file)}:${line} imports forbidden layer ${relative(repositoryRoot, target)}`
					);
				}
			}
		}
	}
	return findings;
};

if (import.meta.main) {
	const findings = collectLayerDependencyFindings();
	if (findings.length > 0) {
		console.error(findings.join("\n"));
		process.exit(1);
	}

	console.log("Layer dependency check OK (infra/http do not import domains or src/index.ts)");
}
