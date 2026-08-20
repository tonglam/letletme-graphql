import {
	rateLimitAggregateDate,
	rateLimitAggregateKey,
	rateLimitAggregateMinute,
	rateLimitDeniedRankingKey,
	rateLimitRecentAggregateKey,
	summarizeRateLimitTotals,
} from "../src/infra/rate-limit-observability";
import { closeRedis, connectRedis, getRateLimitRedis } from "../src/infra/redis";

type ReportOptions = {
	days: number;
	recentMinutes: number | null;
	json: boolean;
	failInteractiveRate: number | null;
	failOnGlobal: boolean;
};

const parseOptions = (argv: readonly string[]): ReportOptions => {
	let days = 2;
	let recentMinutes: number | null = null;
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
		if (argument === "--recent-minutes") {
			recentMinutes = Number(argv[index + 1]);
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
		recentMinutes !== null &&
		(!Number.isInteger(recentMinutes) || recentMinutes < 5 || recentMinutes > 120)
	) {
		throw new Error("--recent-minutes must be an integer from 5 through 120");
	}
	if (
		failInteractiveRate !== null &&
		(!Number.isFinite(failInteractiveRate) || failInteractiveRate < 0 || failInteractiveRate > 1)
	) {
		throw new Error("--fail-interactive-rate must be between 0 and 1");
	}
	return { days, recentMinutes, json, failInteractiveRate, failOnGlobal };
};

const reportDates = (days: number, now = new Date()): string[] =>
	Array.from({ length: days }, (_, offset) => {
		const date = new Date(now);
		date.setUTCDate(date.getUTCDate() - offset);
		return rateLimitAggregateDate(date);
	});

const reportMinutes = (minutes: number, now = new Date()): string[] => {
	const anchor = new Date(now);
	anchor.setUTCSeconds(0, 0);
	return Array.from({ length: minutes }, (_, offset) => {
		const date = new Date(anchor.getTime() - offset * 60 * 1000);
		return rateLimitAggregateMinute(date);
	});
};

const accumulateTotals = (
	totals: Map<string, number>,
	counts: Readonly<Record<string, number>>
): void => {
	for (const [key, count] of Object.entries(counts)) {
		totals.set(key, (totals.get(key) ?? 0) + count);
	}
};

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
	const generatedAt = new Date();
	const dates = reportDates(options.days, generatedAt);
	const minutes =
		options.recentMinutes === null ? [] : reportMinutes(options.recentMinutes, generatedAt);
	const [daily, recentBuckets] = await Promise.all([
		Promise.all(
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
		),
		Promise.all(
			minutes.map(async (minute) => ({
				minute,
				counts: Object.fromEntries(
					Object.entries(await redis.hgetall(rateLimitRecentAggregateKey(minute))).map(
						([key, value]) => [key, Number(value) || 0]
					)
				),
			}))
		),
	]);
	const totals = new Map<string, number>();
	for (const day of daily) {
		accumulateTotals(totals, day.counts);
	}
	const summary = summarizeRateLimitTotals(totals);
	const recentTotals = new Map<string, number>();
	for (const bucket of recentBuckets) accumulateTotals(recentTotals, bucket.counts);
	const recent =
		options.recentMinutes === null
			? null
			: {
					minutes: options.recentMinutes,
					summary: summarizeRateLimitTotals(recentTotals),
					totals: Object.fromEntries(
						[...recentTotals.entries()].sort(([left], [right]) => left.localeCompare(right))
					),
					buckets: recentBuckets,
				};
	const report = {
		policy: "graphql-v3",
		generatedAt: generatedAt.toISOString(),
		days: options.days,
		summary,
		totals: Object.fromEntries(
			[...totals.entries()].sort(([left], [right]) => left.localeCompare(right))
		),
		daily,
		recent,
	};
	if (options.json) {
		console.log(JSON.stringify(report));
	} else {
		console.log(JSON.stringify(report, null, 2));
	}
	const gateSummary = recent?.summary ?? summary;
	if (
		(options.failInteractiveRate !== null &&
			Math.max(gateSummary.interactiveDeniedRate, gateSummary.shadowInteractiveDeniedRate) >
				options.failInteractiveRate) ||
		(options.failOnGlobal && (gateSummary.globalDenied > 0 || gateSummary.globalWouldDenied > 0))
	) {
		process.exitCode = 1;
	}
} finally {
	await closeRedis();
}
