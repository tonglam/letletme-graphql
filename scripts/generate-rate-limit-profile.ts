import rawProductionPolicy from "../src/config/rate-limit/production.json";
import {
	generateValidatedRateLimitProfile,
	type RateLimitTargetObservation,
} from "../src/http/rate-limit-profile-generator";
import { parseGraphQLRateLimitPolicyV3 } from "../src/http/rate-limit-policy-v3";

const valueAfter = (name: string): string => {
	const index = Bun.argv.indexOf(name);
	const value = index >= 0 ? Bun.argv[index + 1] : undefined;
	if (!value) throw new Error(`Missing required ${name}`);
	return value;
};

const observationPath = valueAfter("--observation");
const evidence = valueAfter("--evidence");
const outputIndex = Bun.argv.indexOf("--output");
const outputPath = outputIndex >= 0 ? Bun.argv[outputIndex + 1] : undefined;
if (outputIndex >= 0 && !outputPath) throw new Error("--output requires a path");

const observation = (await Bun.file(observationPath).json()) as RateLimitTargetObservation;
const profile = generateValidatedRateLimitProfile({
	base: parseGraphQLRateLimitPolicyV3(rawProductionPolicy),
	observation,
	evidence,
});
const rendered = `${JSON.stringify(profile, null, "\t")}\n`;
if (outputPath) {
	await Bun.write(outputPath, rendered);
} else {
	process.stdout.write(rendered);
}
