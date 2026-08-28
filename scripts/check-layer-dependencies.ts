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
export const scriptKindForSourceFile = (file: string): ts.ScriptKind =>
	extname(file) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;

export type ModuleSpecifier = {
	value: string;
	line: number;
	dynamic?: boolean;
};

const sourceFilesUnder = (directory: string): string[] => {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const file = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...sourceFilesUnder(file));
		else if (entry.isFile() && isTypeScriptSourceFile(file)) files.push(file);
	}
	return files;
};

export const moduleSpecifiers = (sourceFile: ts.SourceFile): ModuleSpecifier[] => {
	const modules: ModuleSpecifier[] = [];
	// `require` is an ambient CommonJS loader when no lexical binding shadows
	// it. Keep a small alias set so a checked layer cannot hide a relative
	// import behind `const load = require; load(...)` (or an equivalent
	// assignment), while local helpers named `require` remain ordinary calls.
	const requireLoaderBindings = new Set<string>(["require"]);
	type LoaderAliasBinding = {
		name: string;
		marker: ts.Identifier;
		scope: ts.Node;
	};
	const loaderAliasBindings: LoaderAliasBinding[] = [];
	type ProvenCreateRequireBinding = {
		name: string;
		scope: ts.Node;
	};
	const createRequireBindingProvenance: ProvenCreateRequireBinding[] = [];
	const createRequireNamespaceBindingProvenance: ProvenCreateRequireBinding[] = [];
	const bindingContains = (binding: ts.BindingName, name: string): boolean => {
		if (ts.isIdentifier(binding)) return binding.text === name;
		return binding.elements.some((element) => {
			if (ts.isOmittedExpression(element)) return false;
			return bindingContains(element.name, name);
		});
	};
	const scopeHasBinding = (scope: ts.Node, name: string): boolean => {
		if (ts.isFunctionLike(scope)) {
			if (scope.name && ts.isIdentifier(scope.name) && scope.name.text === name) return true;
			if (scope.parameters.some((parameter) => bindingContains(parameter.name, name))) return true;
		}
		if (ts.isCatchClause(scope) && scope.variableDeclaration) {
			if (bindingContains(scope.variableDeclaration.name, name)) return true;
		}
		if (ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope)) {
			for (const statement of scope.statements) {
				if (ts.isVariableStatement(statement)) {
					if (
						statement.declarationList.declarations.some((declaration) =>
							bindingContains(declaration.name, name)
						)
					) {
						return true;
					}
				}
				if (
					(ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
					statement.name?.text === name
				) {
					return true;
				}
				if (ts.isImportDeclaration(statement)) {
					const bindings = statement.importClause?.namedBindings;
					if (
						statement.importClause?.name?.text === name ||
						(bindings && ts.isNamespaceImport(bindings) && bindings.name.text === name) ||
						(bindings &&
							ts.isNamedImports(bindings) &&
							bindings.elements.some((element) => element.name.text === name))
					) {
						return true;
					}
				}
			}
		}
		if (ts.isForStatement(scope)) {
			const initializer = scope.initializer;
			if (initializer && ts.isVariableDeclarationList(initializer)) {
				return initializer.declarations.some((declaration) =>
					bindingContains(declaration.name, name)
				);
			}
		}
		if (ts.isForInStatement(scope) || ts.isForOfStatement(scope)) {
			const initializer = scope.initializer;
			if (ts.isVariableDeclarationList(initializer)) {
				return initializer.declarations.some((declaration) =>
					bindingContains(declaration.name, name)
				);
			}
		}
		return false;
	};
	const isShadowed = (
		identifier: ts.Identifier,
		name: string,
		includeSourceFile = false
	): boolean => {
		let scope: ts.Node | undefined = identifier.parent;
		while (scope) {
			if ((!ts.isSourceFile(scope) || includeSourceFile) && scopeHasBinding(scope, name))
				return true;
			if (ts.isSourceFile(scope)) break;
			scope = scope.parent;
		}
		return false;
	};
	const isLexicalScope = (node: ts.Node): boolean =>
		ts.isSourceFile(node) ||
		ts.isBlock(node) ||
		ts.isModuleBlock(node) ||
		ts.isFunctionLike(node) ||
		ts.isCatchClause(node) ||
		ts.isForStatement(node) ||
		ts.isForInStatement(node) ||
		ts.isForOfStatement(node);
	const scopeFor = (node: ts.Node): ts.Node => {
		let scope: ts.Node | undefined = node.parent;
		while (scope && !isLexicalScope(scope)) scope = scope.parent;
		return scope ?? sourceFile;
	};
	const parentScope = (scope: ts.Node): ts.Node | undefined => {
		let parent: ts.Node | undefined = scope.parent;
		while (parent && !isLexicalScope(parent)) parent = parent.parent;
		return parent;
	};
	const scopeContains = (scope: ts.Node, node: ts.Node): boolean => {
		let current: ts.Node | undefined = node;
		while (current) {
			if (current === scope) return true;
			current = current.parent;
		}
		return false;
	};
	const registerLoaderAlias = (
		name: string,
		marker: ts.Identifier,
		aliasScope: ts.Node = scopeFor(marker)
	): void => {
		requireLoaderBindings.add(name);
		if (loaderAliasBindings.some((binding) => binding.marker === marker)) return;
		loaderAliasBindings.push({ name, marker, scope: aliasScope });
	};
	const unwrapTransparentExpression = (expression: ts.Expression): ts.Expression => {
		let current = expression;
		while (
			ts.isParenthesizedExpression(current) ||
			ts.isAsExpression(current) ||
			ts.isTypeAssertionExpression(current) ||
			ts.isNonNullExpression(current) ||
			ts.isSatisfiesExpression(current)
		) {
			current = current.expression;
		}
		return current;
	};
	const declarationScopeFor = (identifier: ts.Identifier, name: string): ts.Node => {
		let scope: ts.Node | undefined = scopeFor(identifier);
		while (scope) {
			if (scopeHasBinding(scope, name)) {
				const declarations = ts.isVariableStatement(scope)
					? scope.declarationList.declarations
					: ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)
						? scope.initializer && ts.isVariableDeclarationList(scope.initializer)
							? scope.initializer.declarations
							: undefined
						: ts.isBlock(scope) || ts.isModuleBlock(scope) || ts.isSourceFile(scope)
							? scope.statements.flatMap((statement) =>
									ts.isVariableStatement(statement)
										? [...statement.declarationList.declarations]
										: []
								)
							: undefined;
				const declaration = declarations?.find((candidate) =>
					bindingContains(candidate.name, name)
				);
				return declaration ? loaderAliasScopeFor(declaration) : scope;
			}
			scope = parentScope(scope);
		}
		return scopeFor(identifier);
	};
	const loaderAliasScopeFor = (declaration: ts.VariableDeclaration): ts.Node => {
		const declarationList = declaration.parent;
		const isVarDeclaration =
			(declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0;
		if (!isVarDeclaration) return scopeFor(declaration.name);
		let scope: ts.Node | undefined = scopeFor(declaration.name);
		while (scope && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) {
			scope = parentScope(scope);
		}
		return scope ?? sourceFile;
	};
	const registerCreateRequireBinding = (
		name: string,
		marker: ts.Identifier,
		options: { namespace?: boolean; scope?: ts.Node } = {}
	): void => {
		const { namespace = false, scope = scopeFor(marker) } = options;
		const bindings = namespace
			? createRequireNamespaceBindingProvenance
			: createRequireBindingProvenance;
		bindings.push({ name, scope });
	};
	const isVisibleCreateRequireBinding = (
		identifier: ts.Identifier,
		name: string,
		namespace = false
	): boolean => {
		const bindings = namespace
			? createRequireNamespaceBindingProvenance
			: createRequireBindingProvenance;
		if (bindings.length === 0) return false;
		const referenceScope = scopeFor(identifier);
		const depth = (scope: ts.Node): number => {
			let value = 0;
			let current: ts.Node | undefined = scope;
			while (current) {
				value += 1;
				current = parentScope(current);
			}
			return value;
		};
		return bindings
			.filter((binding) => binding.name === name && scopeContains(binding.scope, identifier))
			.sort((left, right) => depth(right.scope) - depth(left.scope))
			.some((binding) => {
				let scope: ts.Node | undefined = referenceScope;
				while (scope && scope !== binding.scope) {
					if (scopeHasBinding(scope, name)) return false;
					scope = parentScope(scope);
				}
				return scope === binding.scope;
			});
	};
	const isVisibleLoaderAlias = (identifier: ts.Identifier, name: string): boolean => {
		if (!requireLoaderBindings.has(name) || name === "require") return false;
		const referenceScope = scopeFor(identifier);
		return loaderAliasBindings
			.filter((binding) => binding.name === name && scopeContains(binding.scope, identifier))
			.sort((left, right) => {
				const depth = (scope: ts.Node): number => {
					let value = 0;
					let current: ts.Node | undefined = scope;
					while (current) {
						value += 1;
						current = parentScope(current);
					}
					return value;
				};
				return depth(right.scope) - depth(left.scope);
			})
			.some((binding) => {
				let scope: ts.Node | undefined = referenceScope;
				while (scope && scope !== binding.scope) {
					if (scopeHasBinding(scope, name)) return false;
					scope = parentScope(scope);
				}
				return scope === binding.scope;
			});
	};
	const moduleSpecifierFromLoader = (initializer: ts.Expression): string | undefined => {
		let expression = unwrapTransparentExpression(initializer);
		while (ts.isAwaitExpression(expression)) {
			expression = unwrapTransparentExpression(expression.expression);
		}
		if (
			!ts.isCallExpression(expression) ||
			expression.arguments.length < 1 ||
			!ts.isStringLiteralLike(expression.arguments[0])
		) {
			return undefined;
		}
		const callee = unwrapTransparentExpression(expression.expression);
		if (
			ts.isIdentifier(callee) &&
			callee.text === "require" &&
			!isShadowed(callee, "require", true)
		)
			return expression.arguments[0].text;
		if (callee.kind === ts.SyntaxKind.ImportKeyword) return expression.arguments[0].text;
		return undefined;
	};
	const collectCreateRequireBindings = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			if (node.moduleSpecifier.text === "node:module" || node.moduleSpecifier.text === "module") {
				if (
					node.importClause?.namedBindings &&
					ts.isNamespaceImport(node.importClause.namedBindings)
				) {
					registerCreateRequireBinding(
						node.importClause.namedBindings.name.text,
						node.importClause.namedBindings.name,
						{ namespace: true, scope: sourceFile }
					);
				}
				if (
					node.importClause?.namedBindings &&
					ts.isNamedImports(node.importClause.namedBindings)
				) {
					for (const specifier of node.importClause.namedBindings.elements) {
						if (
							specifier.propertyName?.text === "createRequire" ||
							specifier.name.text === "createRequire"
						) {
							registerCreateRequireBinding(specifier.name.text, specifier.name, {
								scope: sourceFile,
							});
						}
					}
				}
			}
		}
		if (ts.isVariableStatement(node)) {
			for (const declaration of node.declarationList.declarations) {
				const initializer = declaration.initializer
					? unwrapTransparentExpression(declaration.initializer)
					: undefined;
				if (
					ts.isIdentifier(declaration.name) &&
					initializer &&
					ts.isIdentifier(initializer) &&
					requireLoaderBindings.has(initializer.text) &&
					(initializer.text === "require"
						? !isShadowed(initializer, "require", true)
						: isVisibleLoaderAlias(initializer, initializer.text))
				) {
					registerLoaderAlias(
						declaration.name.text,
						declaration.name,
						loaderAliasScopeFor(declaration)
					);
				}
				const importedModule = declaration.initializer
					? moduleSpecifierFromLoader(declaration.initializer)
					: undefined;
				if (importedModule !== "node:module" && importedModule !== "module") {
					continue;
				}
				if (ts.isIdentifier(declaration.name)) {
					registerCreateRequireBinding(declaration.name.text, declaration.name, {
						namespace: true,
						scope: loaderAliasScopeFor(declaration),
					});
					continue;
				}
				if (!ts.isObjectBindingPattern(declaration.name)) continue;
				for (const element of declaration.name.elements) {
					const importedName =
						element.propertyName &&
						(ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName))
							? element.propertyName.text
							: element.name.getText(sourceFile);
					if (importedName === "createRequire" && ts.isIdentifier(element.name)) {
						registerCreateRequireBinding(element.name.text, element.name, {
							scope: loaderAliasScopeFor(declaration),
						});
					}
				}
			}
		}
		if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
			const right = unwrapTransparentExpression(node.right);
			if (
				ts.isIdentifier(node.left) &&
				ts.isIdentifier(right) &&
				requireLoaderBindings.has(right.text) &&
				(right.text === "require"
					? !isShadowed(right, "require", true)
					: isVisibleLoaderAlias(right, right.text))
			) {
				registerLoaderAlias(
					node.left.text,
					node.left,
					declarationScopeFor(node.left, node.left.text)
				);
			}
		}
		ts.forEachChild(node, collectCreateRequireBindings);
	};
	collectCreateRequireBindings(sourceFile);
	const add = (node: ts.Node, value: string): void => {
		if (value.startsWith(".")) {
			const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
			modules.push({ value, line });
		}
	};
	const addUnresolvedDynamic = (node: ts.Node): void => {
		const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
		modules.push({ value: "", line, dynamic: true });
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
		if (ts.isModuleDeclaration(node) && ts.isStringLiteralLike(node.name)) {
			add(node.name, node.name.text);
		}
		if (ts.isCallExpression(node)) {
			const expression = unwrapTransparentExpression(node.expression);
			const isCreateRequireNamespaceCall =
				ts.isPropertyAccessExpression(expression) &&
				ts.isIdentifier(expression.expression) &&
				expression.name.text === "createRequire" &&
				isVisibleCreateRequireBinding(expression.expression, expression.expression.text, true);
			if (
				(ts.isIdentifier(expression) &&
					isVisibleCreateRequireBinding(expression, expression.text)) ||
				isCreateRequireNamespaceCall
			) {
				// A createRequire loader can reach any runtime module through a later
				// identifier call. Reject the loader in checked layers rather than
				// attempting to infer every alias and closure that it can produce.
				addUnresolvedDynamic(node);
			}
			if (
				(ts.isIdentifier(expression) &&
					((expression.text === "require" && !isShadowed(expression, "require", true)) ||
						isVisibleLoaderAlias(expression, expression.text))) ||
				(ts.isPropertyAccessExpression(expression) &&
					ts.isIdentifier(expression.expression) &&
					expression.expression.text === "module" &&
					!isShadowed(expression.expression, "module", true) &&
					expression.name.text === "require") ||
				// Dynamic import may carry a second import-options argument. The
				// module specifier is still always its first argument, so inspect it
				// regardless of the options object's presence.
				(expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length >= 1)
			) {
				const argument = node.arguments[0];
				if (argument && ts.isStringLiteralLike(argument)) add(argument, argument.text);
				else if (argument) addUnresolvedDynamic(node);
			}
		}
		ts.forEachChild(node, visit);
	});
	for (const reference of sourceFile.referencedFiles) {
		if (!reference.fileName.startsWith(".")) continue;
		const line = sourceFile.getLineAndCharacterOfPosition(reference.pos).line + 1;
		modules.push({ value: reference.fileName, line });
	}
	for (const reference of sourceFile.typeReferenceDirectives) {
		if (!reference.fileName.startsWith(".")) continue;
		const line = sourceFile.getLineAndCharacterOfPosition(reference.pos).line + 1;
		modules.push({ value: reference.fileName, line });
	}
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
				scriptKindForSourceFile(file)
			);
			for (const { value, line, dynamic } of moduleSpecifiers(sourceFile)) {
				if (dynamic) {
					findings.push(
						`${relative(repositoryRoot, file)}:${line} uses a nonliteral dynamic module specifier that cannot be checked`
					);
					continue;
				}
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
