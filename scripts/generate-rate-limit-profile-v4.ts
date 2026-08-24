import rawProductionPolicy from "../src/config/rate-limit/production-v4.json";
import {
	generateValidatedRateLimitProfileV4,
	type RateLimitTargetObservationV4,
} from "../src/http/rate-limit-profile-generator-v4";
import { parseGraphQLRateLimitPolicyV4 } from "../src/http/rate-limit-policy-v4";

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

const observation = (await Bun.file(observationPath).json()) as RateLimitTargetObservationV4;
const profile = generateValidatedRateLimitProfileV4({
	base: parseGraphQLRateLimitPolicyV4(rawProductionPolicy),
	observation,
	evidence,
});
const rendered = `${JSON.stringify(profile, null, "\t")}\n`;
if (outputPath) await Bun.write(outputPath, rendered);
else process.stdout.write(rendered);
