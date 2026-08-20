import {
	rateLimitAggregateDate,
	rateLimitAggregateKey,
	rateLimitDeniedRankingKey,
	summarizeRateLimitTotals,
} from "../src/infra/rate-limit-observability";
import { closeRedis, connectRedis, getRateLimitRedis } from "../src/infra/redis";

type ReportOptions = {
	days: number;
	json: boolean;
	failInteractiveRate: number | null;
	failOnGlobal: boolean;
};

const parseOptions = (argv: readonly string[]): ReportOptions => {
	let days = 2;
	let json = false;
	let failInteractiveRate: number | null = null;
	let failOnGlobal = false;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--json") {
			json = true;
			continue;
		}
		if (argument === "--fail-on-global") {
			failOnGlobal = true;
			continue;
		}
		if (argument === "--days") {
			days = Number(argv[index + 1]);
			index += 1;
			continue;
		}
		if (argument === "--fail-interactive-rate") {
			failInteractiveRate = Number(argv[index + 1]);
			index += 1;
			continue;
		}
		throw new Error(`Unknown argument: ${argument}`);
	}
	if (!Number.isInteger(days) || days < 1 || days > 14) {
		throw new Error("--days must be an integer from 1 through 14");
	}
	if (
		failInteractiveRate !== null &&
		(!Number.isFinite(failInteractiveRate) || failInteractiveRate < 0 || failInteractiveRate > 1)
	) {
		throw new Error("--fail-interactive-rate must be between 0 and 1");
	}
	return { days, json, failInteractiveRate, failOnGlobal };
};

const reportDates = (days: number, now = new Date()): string[] =>
	Array.from({ length: days }, (_, offset) => {
		const date = new Date(now);
		date.setUTCDate(date.getUTCDate() - offset);
		return rateLimitAggregateDate(date);
	});

const parseRanking = (
	values: readonly string[]
): Array<{ fingerprintKey: string; count: number }> => {
	const ranking: Array<{ fingerprintKey: string; count: number }> = [];
	for (let index = 0; index < values.length; index += 2) {
		ranking.push({
			fingerprintKey: values[index] ?? "",
			count: Number(values[index + 1]) || 0,
		});
	}
	return ranking;
};

const options = parseOptions(Bun.argv.slice(2));
await connectRedis();
try {
	const redis = getRateLimitRedis();
	const dates = reportDates(options.days);
	const daily = await Promise.all(
		dates.map(async (date) => {
			const [counts, denied] = await Promise.all([
				redis.hgetall(rateLimitAggregateKey(date)),
				redis.zrevrange(rateLimitDeniedRankingKey(date), 0, 19, "WITHSCORES"),
			]);
			return {
				date,
				counts: Object.fromEntries(
					Object.entries(counts).map(([key, value]) => [key, Number(value) || 0])
				),
				denied: parseRanking(denied),
			};
		})
	);
	const totals = new Map<string, number>();
	for (const day of daily) {
		for (const [key, count] of Object.entries(day.counts)) {
			totals.set(key, (totals.get(key) ?? 0) + count);
		}
	}
	const summary = summarizeRateLimitTotals(totals);
	const report = {
		policy: "graphql-v3",
		generatedAt: new Date().toISOString(),
		days: options.days,
		summary,
		totals: Object.fromEntries(
			[...totals.entries()].sort(([left], [right]) => left.localeCompare(right))
		),
		daily,
	};
	if (options.json) {
		console.log(JSON.stringify(report));
	} else {
		console.log(JSON.stringify(report, null, 2));
	}
	if (
		(options.failInteractiveRate !== null &&
			Math.max(summary.interactiveDeniedRate, summary.shadowInteractiveDeniedRate) >
				options.failInteractiveRate) ||
		(options.failOnGlobal && (summary.globalDenied > 0 || summary.globalWouldDenied > 0))
	) {
		process.exitCode = 1;
	}
} finally {
	await closeRedis();
}
