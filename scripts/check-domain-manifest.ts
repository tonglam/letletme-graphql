import { access, readFile, writeFile } from "node:fs/promises";
import {
	GRAPHQL_DOMAIN_MANIFEST,
	validateGraphQLDomainManifest,
} from "../src/graphql/domain-manifest";

const documentationPath = new URL("../documentation/GRAPHQL_DOMAIN_MANIFEST.md", import.meta.url);
const begin = "<!-- BEGIN GENERATED GRAPHQL DOMAIN MANIFEST -->";
const end = "<!-- END GENERATED GRAPHQL DOMAIN MANIFEST -->";

const errors = [...validateGraphQLDomainManifest()];
for (const entry of GRAPHQL_DOMAIN_MANIFEST) {
	for (const modulePath of [entry.typeDefsModule, entry.resolversModule]) {
		try {
			await access(new URL(`../${modulePath}`, import.meta.url));
		} catch {
			errors.push(`${entry.name}: missing module ${modulePath}`);
		}
	}
}
if (errors.length > 0) {
	console.error(errors.join("\n"));
	process.exit(1);
}

const generated = [
	begin,
	"| Domain | TypeDefs | Resolvers | Root fields | Auth classes | Rate-limit budgets |",
	"| --- | --- | --- | --- | --- | --- |",
	...GRAPHQL_DOMAIN_MANIFEST.map((entry) => {
		const budgets = Object.entries(entry.rateLimitBudget)
			.map(([field, budget]) => `${field}=${budget}`)
			.join(", ");
		return `| ${entry.name} | \`${entry.typeDefsModule}\` | \`${entry.resolversModule}\` | ${entry.rootFields.join(", ")} | ${entry.auth.join(", ") || "none"} | ${budgets} |`;
	}),
	end,
].join("\n");

const current = await readFile(documentationPath, "utf8");
const start = current.indexOf(begin);
const finish = current.indexOf(end);
if (start < 0 || finish < start) {
	console.error(`Missing generated manifest markers in ${documentationPath.pathname}`);
	process.exit(1);
}
const actual = current.slice(start, finish + end.length).trim();
if (actual !== generated) {
	if (process.argv.includes("--write")) {
		const updated = `${current.slice(0, start)}${generated}${current.slice(finish + end.length)}`;
		await writeFile(documentationPath, updated);
		console.log("GraphQL domain manifest regenerated");
		process.exit(0);
	}
	console.error("GraphQL domain manifest is stale; regenerate the marked block.");
	process.exit(1);
}

console.log(`GraphQL domain manifest OK (${GRAPHQL_DOMAIN_MANIFEST.length} domains)`);
