import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSourceModule } from "../../scripts/check-layer-dependencies";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

test("layer checker applies TypeScript extension substitution to ESM .js imports", () => {
	const resolved = resolveSourceModule(
		resolve(repositoryRoot, "src/infra/env.ts"),
		"../domains/entries/service.js"
	);
	expect(resolved).toBe(resolve(repositoryRoot, "src/domains/entries/service.ts"));
});
