import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import ts from "typescript";

const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
const sourceRoot = join(repositoryRoot, "src");
const checkedRoots = [join(sourceRoot, "infra"), join(sourceRoot, "http")];
const forbiddenRoots = [join(sourceRoot, "domains"), join(sourceRoot, "index.ts")];

const sourceFilesUnder = (directory: string): string[] => {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const file = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...sourceFilesUnder(file));
		else if (entry.isFile() && [".ts", ".tsx"].includes(extname(file))) files.push(file);
	}
	return files;
};

const moduleSpecifiers = (sourceFile: ts.SourceFile): Array<{ value: string; line: number }> => {
	const modules: Array<{ value: string; line: number }> = [];
	const add = (node: ts.Node, value: string): void => {
		if (value.startsWith(".")) {
			const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
			modules.push({ value, line });
		}
	};
	ts.forEachChild(sourceFile, function visit(node): void {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
			if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
				add(node.moduleSpecifier, node.moduleSpecifier.text);
			}
		}
		if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
			const expression = node.moduleReference.expression;
			if (expression && ts.isStringLiteral(expression)) add(expression, expression.text);
		}
		if (ts.isCallExpression(node)) {
			const expression = node.expression;
			if (
				(ts.isIdentifier(expression) && expression.text === "require") ||
				(expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1)
			) {
				const argument = node.arguments[0];
				if (argument && ts.isStringLiteral(argument)) add(argument, argument.text);
			}
		}
		ts.forEachChild(node, visit);
	});
	return modules;
};

const resolveSourceModule = (fromFile: string, specifier: string): string | null => {
	const base = resolve(dirname(fromFile), specifier);
	const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")];
	return (
		candidates.find((candidate) => {
			try {
				return readFileSync(candidate, "utf8") !== undefined;
			} catch {
				return false;
			}
		}) ?? null
	);
};

const under = (file: string, root: string): boolean => {
	const path = normalize(relative(root, file));
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

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

if (findings.length > 0) {
	console.error(findings.join("\n"));
	process.exit(1);
}

console.log("Layer dependency check OK (infra/http do not import domains or src/index.ts)");
