import { createHash, createHmac } from "crypto";

const total = Number(process.env.P0_PROBE_REQUESTS ?? "700");
const label = process.env.P0_PROBE_SUBJECT?.trim() ?? "";
const secret = process.env.BACKEND_PROXY_SECRET?.trim() ?? "";
if (!Number.isSafeInteger(total) || total < 1 || total > 1_000) {
	throw new Error("P0_PROBE_REQUESTS must be an integer from 1 through 1000");
}
if (!/^[A-Za-z0-9._:-]{8,64}$/.test(label)) {
	throw new Error("P0_PROBE_SUBJECT must be an 8-64 character safe identifier");
}
if (Buffer.byteLength(secret, "utf8") < 32) {
	throw new Error("BACKEND_PROXY_SECRET must contain at least 32 bytes");
}

const subject = createHash("sha256").update(`p0-regression:${label}`).digest("hex");
const query = `query P0RateLimitRegression {
	currentEventInfo { season currentEvent nextEvent }
	events(limit: 1) {
		id
		name
		deadlineTime
		averageEntryScore
		finished
		dataChecked
		highestScoringEntry
		deadlineTimeEpoch
		deadlineTimeGameOffset
		highestScore
		isPrevious
	}
}`;

const requestOnce = async (index: number): Promise<number> => {
	const now = Math.floor(Date.now() / 1000);
	const payload = JSON.stringify({
		aud: "letletme-graphql",
		sub: subject,
		iat: now,
		exp: now + 60,
	});
	const response = await fetch("http://127.0.0.1:4000/graphql", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Request-Id": `p0-${label}-${index}`.slice(0, 96),
			"X-Ingress-Context": Buffer.from(payload).toString("base64url"),
			"X-Ingress-Context-Sig": createHmac("sha256", secret).update(payload).digest("base64url"),
		},
		body: JSON.stringify({ operationName: "P0RateLimitRegression", query }),
		signal: AbortSignal.timeout(10_000),
	});
	await response.body?.cancel();
	return response.status;
};

const statuses: number[] = [];
for (let offset = 0; offset < total; offset += 20) {
	statuses.push(
		...(await Promise.all(
			Array.from({ length: Math.min(20, total - offset) }, (_, index) =>
				requestOnce(offset + index)
			)
		))
	);
}

const counts = Object.fromEntries(
	[...new Set(statuses)]
		.sort((left, right) => left - right)
		.map((status) => [String(status), statuses.filter((candidate) => candidate === status).length])
);
process.stdout.write(
	`${JSON.stringify({
		operation: "p0-rate-limit-regression",
		total,
		rateLimited: counts["429"] ?? 0,
		nonRateLimited: total - (counts["429"] ?? 0),
		statuses: counts,
	})}\n`
);
