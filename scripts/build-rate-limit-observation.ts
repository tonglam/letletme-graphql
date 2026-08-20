import {
	buildRateLimitTargetObservation,
	parseCapacityLoadReport,
} from "../src/http/rate-limit-observation";

const valueAfter = (name: string): string => {
	const index = Bun.argv.indexOf(name);
	const value = index >= 0 ? Bun.argv[index + 1] : undefined;
	if (!value) throw new Error(`Missing required ${name}`);
	return value;
};

const reportPath = valueAfter("--load-report");
const logsPath = valueAfter("--logs");
const outputIndex = Bun.argv.indexOf("--output");
const outputPath = outputIndex >= 0 ? Bun.argv[outputIndex + 1] : undefined;
if (outputIndex >= 0 && !outputPath) throw new Error("--output requires a path");

const report = parseCapacityLoadReport(JSON.parse(await Bun.file(reportPath).text()) as unknown);
const logs = await Bun.file(logsPath).text();
const observation = buildRateLimitTargetObservation({
	report,
	logLines: logs.split("\n"),
});
const rendered = `${JSON.stringify(observation, null, "\t")}\n`;
if (outputPath) await Bun.write(outputPath, rendered);
else process.stdout.write(rendered);
