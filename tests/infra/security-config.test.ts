import { describe, expect, test } from "bun:test";

const gitignore = await Bun.file(".gitignore").text();
const gitleaks = await Bun.file(".gitleaks.toml").text();

const gitCheckIgnore = (path: string): boolean => {
	const result = Bun.spawnSync(["git", "check-ignore", "--no-index", "--quiet", path]);
	return result.exitCode === 0;
};

describe("secret-file repository policy", () => {
	test("ignores environment files while explicitly tracking examples", () => {
		expect(gitignore).toContain(".env\n.env.*");
		expect(gitignore).toContain("!.env.example");
		expect(gitignore).toContain("!.env.deploy.example");
		expect(gitCheckIgnore(".env.production")).toBe(true);
		expect(gitCheckIgnore(".env.example")).toBe(false);
		expect(gitCheckIgnore(".env.deploy.example")).toBe(false);
	});

	test("does not allowlist environment paths in Gitleaks", () => {
		expect(gitleaks).not.toMatch(/\\\.env(?:\\$|\\\.)/);
		expect(gitleaks).toContain("YOUR_TOKEN(_HERE)?");
	});
});
