import { describe, expect, it } from "bun:test";
import {
	poolCheckoutNeedsWaitMetric,
	runDatabaseHealthCheck,
	type DatabaseHealthClient,
} from "../../src/infra/database";

const makeClient = (failOn?: string) => {
	const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
	let released = false;
	const client: DatabaseHealthClient = {
		query: async (text, values) => {
			calls.push({ text, values });
			if (text === failOn) throw new Error("database unavailable");
		},
		release: () => {
			released = true;
		},
	};
	return { client, calls, wasReleased: () => released };
};

describe("PostgreSQL health probe", () => {
	it("recognizes the specific checkout queued behind a busy pool client", () => {
		expect(poolCheckoutNeedsWaitMetric(0, 1, 0, 0)).toBe(true);
		expect(poolCheckoutNeedsWaitMetric(1, 2, 0, 0)).toBe(true);
		expect(poolCheckoutNeedsWaitMetric(0, 1, 1, 0)).toBe(false);
		expect(poolCheckoutNeedsWaitMetric(0, 1, 1, 1)).toBe(true);
		expect(poolCheckoutNeedsWaitMetric(0, 1, 2, 1)).toBe(false);
		expect(poolCheckoutNeedsWaitMetric(1, 1, 0, 0)).toBe(false);
		expect(poolCheckoutNeedsWaitMetric(-1, 1, 0, 0)).toBe(false);
	});

	it("scopes a two-second statement timeout to a checked-out transaction", async () => {
		const fake = makeClient();
		await runDatabaseHealthCheck(async () => fake.client, 2_000);

		expect(fake.calls.map(({ text }) => text)).toEqual([
			"BEGIN",
			"SELECT set_config('statement_timeout', $1, true)",
			"SELECT 1",
			"COMMIT",
		]);
		expect(fake.calls[1]?.values).toEqual(["2000ms"]);
		expect(fake.wasReleased()).toBe(true);
	});

	it("rolls back and releases the client after a failed probe", async () => {
		const fake = makeClient("SELECT 1");
		await expect(runDatabaseHealthCheck(async () => fake.client)).rejects.toThrow(
			"database unavailable"
		);
		expect(fake.calls.map(({ text }) => text)).toEqual([
			"BEGIN",
			"SELECT set_config('statement_timeout', $1, true)",
			"SELECT 1",
			"ROLLBACK",
		]);
		expect(fake.wasReleased()).toBe(true);
	});
});
