import { describe, expect, it } from "bun:test";
import {
	poolCheckoutNeedsWaitMetric,
	createDatabaseExecutor,
	runDatabaseHealthCheck,
	type DatabaseHealthClient,
} from "../../src/infra/database";
import { ExecutionScope } from "../../src/infra/execution-scope";

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
		// The synchronous +1 proves that this checkout itself entered the
		// pending queue; a later pool-wide sample could miss this short wait.
		expect(poolCheckoutNeedsWaitMetric(0, 1, 0, 2, 2)).toBe(true);
		expect(poolCheckoutNeedsWaitMetric(0, 0, 0, 2, 2)).toBe(false);
		// One idle client is enough for the first queued checkout, but not for
		// the second checkout behind it.
		expect(poolCheckoutNeedsWaitMetric(1, 2, 2, 2, 2)).toBe(false);
		expect(poolCheckoutNeedsWaitMetric(1, 2, 1, 2, 2)).toBe(true);
		expect(poolCheckoutNeedsWaitMetric(0, 1, 1, 2, 2)).toBe(false);
		// A pool below max can open a spare slot; do not call that contention.
		expect(poolCheckoutNeedsWaitMetric(1, 2, 1, 2, 10)).toBe(false);
		expect(poolCheckoutNeedsWaitMetric(-1, 0, 1, 2, 2)).toBe(false);
		expect(poolCheckoutNeedsWaitMetric(0, 1, 2, 0, 0)).toBe(false);
	});

	it("scopes a two-second statement timeout to a checked-out transaction", async () => {
		const fake = makeClient();
		await runDatabaseHealthCheck(async () => fake.client, 2_000);

		expect(fake.calls.map(({ text }) => text)).toEqual([
			"BEGIN READ ONLY",
			"SELECT set_config('statement_timeout', $1, true)",
			"SELECT 1",
			"COMMIT",
		]);
		const effective = Number(String(fake.calls[1]?.values?.[0]).replace("ms", ""));
		expect(effective).toBeGreaterThan(0);
		expect(effective).toBeLessThanOrEqual(2000);
		expect(fake.wasReleased()).toBe(true);
	});

	it("rolls back and releases the client after a failed probe", async () => {
		const fake = makeClient("SELECT 1");
		await expect(runDatabaseHealthCheck(async () => fake.client)).rejects.toThrow(
			"database unavailable"
		);
		expect(fake.calls.map(({ text }) => text)).toEqual([
			"BEGIN READ ONLY",
			"SELECT set_config('statement_timeout', $1, true)",
			"SELECT 1",
			"ROLLBACK",
		]);
		expect(fake.wasReleased()).toBe(true);
	});
});

describe("bounded read-only SQL execution", () => {
	it("does not start SQL on a checkout arriving after cancellation", async () => {
		let arrive!: (client: DatabaseHealthClient) => void;
		const checkout = new Promise<DatabaseHealthClient>((resolve) => {
			arrive = resolve;
		});
		const scope = new ExecutionScope();
		const calls: string[] = [];
		const releases: Array<boolean | undefined> = [];
		const work = createDatabaseExecutor(scope, () => checkout).query("SELECT 1");
		scope.cancel();
		await expect(work).rejects.toThrow("no longer available");
		arrive({
			query: async (text) => {
				calls.push(text);
			},
			release: (destroy) => {
				releases.push(destroy);
			},
		});
		await Bun.sleep(1);
		expect(calls).toEqual([]);
		expect(releases).toEqual([undefined]);
		scope.dispose();
	});

	it("discards an active cancelled connection exactly once and observes its rejection", async () => {
		const scope = new ExecutionScope();
		let started!: () => void;
		const gate = new Promise<void>((resolve) => {
			started = resolve;
		});
		let fail!: (error: Error) => void;
		const releases: boolean[] = [];
		const client: DatabaseHealthClient = {
			query: async (text) => {
				if (text === "SELECT slow") {
					started();
					return new Promise((_, reject) => {
						fail = reject;
					});
				}
			},
			release: (destroy) => {
				releases.push(Boolean(destroy));
				fail(new Error("connection closed"));
			},
		};
		const work = createDatabaseExecutor(scope, async () => client).query("SELECT slow");
		await gate;
		scope.cancel();
		await expect(work).rejects.toThrow("no longer available");
		expect(releases).toEqual([true]);
		scope.dispose();
	});

	it("discards on rollback failure instead of returning a failed transaction", async () => {
		const releases: boolean[] = [];
		const client: DatabaseHealthClient = {
			query: async (text) => {
				if (text === "SELECT bad" || text === "ROLLBACK") throw new Error("query failed");
			},
			release: (destroy) => {
				releases.push(Boolean(destroy));
			},
		};
		await expect(
			createDatabaseExecutor(undefined, async () => client).query("SELECT bad")
		).rejects.toThrow("query failed");
		expect(releases).toEqual([true]);
	});

	it("deducts checkout time from SQL timeout and shares an absolute budget across queries", async () => {
		const scope = new ExecutionScope(Date.now() + 180);
		const configured: number[] = [];
		const client: DatabaseHealthClient = {
			query: async (text, args) => {
				if (text.includes("set_config"))
					configured.push(Number(String(args?.[0]).replace("ms", "")));
				if (text === "SELECT 1") await Bun.sleep(20);
			},
			release: () => {},
		};
		const executor = createDatabaseExecutor(scope, async () => {
			await Bun.sleep(20);
			return client;
		});
		await executor.query("SELECT 1");
		await executor.query("SELECT 1");
		expect(configured).toHaveLength(2);
		expect(configured[0]).toBeLessThan(180);
		expect(configured[1]).toBeLessThan(configured[0]! - 20);
		scope.dispose();
		await expect(executor.query("SELECT 1")).rejects.toThrow("no longer available");
	});

	it("bounds a stalled BEGIN and closes its connection", async () => {
		let fail!: (error: Error) => void;
		const releases: boolean[] = [];
		const client: DatabaseHealthClient = {
			query: () =>
				new Promise((_, reject) => {
					fail = reject;
				}),
			release: (destroy) => {
				releases.push(Boolean(destroy));
				fail(new Error("closed"));
			},
		};
		await expect(
			createDatabaseExecutor(undefined, async () => client, 20).query("SELECT 1")
		).rejects.toThrow("no longer available");
		expect(releases).toEqual([true]);
	});
});
