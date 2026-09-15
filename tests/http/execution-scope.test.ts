import { describe, expect, it } from "bun:test";
import { ExecutionScope } from "../../src/infra/execution-scope";
import { createDatabaseExecutor } from "../../src/infra/database";

// These checks exercise the request boundary independently from PostgreSQL
// fixtures; the real driver cancellation tests live in infra integration.
describe("request execution lifecycle", () => {
	it("stops a swallowed SQL timeout from returning default data or starting fallback SQL", async () => {
		const scope = new ExecutionScope(Date.now() + 20);
		let calls = 0;
		const db = createDatabaseExecutor(undefined, async () => ({
			query: async () => {
				calls++;
				return new Promise(() => {});
			},
			release: () => {},
		}));
		const work = scope.run(async () => {
			try {
				await db.query("SELECT slow");
			} catch {
				/* repository wrapping */
			}
			try {
				await db.query("SELECT fallback");
			} catch {
				/* legacy default */
			}
			return [];
		});
		await expect(scope.wait(work)).rejects.toThrow("no longer available");
		await scope.settleCleanup();
		expect(calls).toBe(1);
		scope.dispose();
	});

	it("retains the scope for a streaming response and aborts it when the consumer leaves", async () => {
		const scope = new ExecutionScope();
		let cancelled = false;
		let finished = 0;
		const response = scope.finishResponse(
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array([1]));
					},
					cancel() {
						cancelled = true;
					},
				})
			),
			() => {
				finished++;
			}
		);
		expect(scope.signal.aborted).toBe(false);
		const reader = response.body!.getReader();
		expect((await reader.read()).done).toBe(false);
		await reader.cancel();
		expect(scope.signal.aborted).toBe(true);
		expect(cancelled).toBe(true);
		expect(finished).toBe(1);
	});

	it("cancels an open response when the upstream request aborts", async () => {
		const parent = new AbortController();
		const scope = new ExecutionScope(undefined, parent.signal);
		const response = scope.finishResponse(new Response(new ReadableStream()));
		parent.abort();
		await expect(response.text()).rejects.toThrow();
		expect(scope.signal.aborted).toBe(true);
	});
});

// Full HTTP fault injection is restricted to a disposable, local fixture.
import { beforeAll, afterAll } from "bun:test";
import { createHmac } from "node:crypto";
import { Pool } from "pg";
const httpSuite =
	process.env.RUN_DATABASE_EXECUTION_INTEGRATION === "1" && process.env.FIXTURE_ADMIN_DATABASE_URL
		? describe
		: describe.skip;
httpSuite("HTTP Mini authentication deadline (local fixture)", () => {
	let child: ReturnType<typeof Bun.spawn>;
	let admin: Pool;
	let url: string;
	beforeAll(async () => {
		const adminUrl = new URL(process.env.FIXTURE_ADMIN_DATABASE_URL!);
		const readUrl = new URL(process.env.DATABASE_URL!);
		if (![adminUrl, readUrl].every((value) => ["127.0.0.1", "localhost"].includes(value.hostname)))
			throw new Error("HTTP fault injection requires local fixtures");
		admin = new Pool({ connectionString: adminUrl.toString(), max: 2 });
		const probe = Bun.serve({ port: 0, fetch: () => new Response() });
		const port = probe.port!;
		await probe.stop(true);
		url = `http://127.0.0.1:${port}`;
		child = Bun.spawn([process.execPath, "--env-file=/dev/null", "src/index.ts"], {
			env: {
				...process.env,
				PORT: String(port),
				LOG_LEVEL: "error",
				GRAPHQL_RATE_LIMIT_MODE: "shadow-v4",
			},
			stdout: "ignore",
			stderr: "ignore",
		});
		let ready = false;
		for (let i = 0; i < 100; i++) {
			try {
				if ((await fetch(url + "/health/live", { signal: AbortSignal.timeout(500) })).ok) {
					ready = true;
					break;
				}
			} catch {
				/* starting */
			}
			await Bun.sleep(100);
		}
		if (!ready) throw new Error("Fixture HTTP server did not start");
	}, 15000);
	afterAll(async () => {
		child?.kill("SIGTERM");
		if (child) await child.exited;
		await admin?.end();
	});
	const headers = () => {
		const now = Math.floor(Date.now() / 1000);
		const envelope = JSON.stringify({
			v: 2,
			aud: "letletme-graphql",
			trafficClass: "mini",
			subject: "a".repeat(64),
			abuseSubject: "b".repeat(64),
			workload: "public-other",
			iat: now,
			exp: now + 60,
		});
		return {
			"content-type": "application/json",
			Authorization: "Bearer fixture-only-deadline-token",
			"X-Ingress-Context": Buffer.from(envelope).toString("base64url"),
			"X-Ingress-Context-Sig": createHmac("sha256", process.env.BACKEND_PROXY_SECRET!)
				.update(envelope)
				.digest("base64url"),
		};
	};
	const miniActive = async () =>
		(
			await admin.query<{ n: number }>(
				"SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='letletme-graphql' AND state='active' AND query LIKE '%bauth.mini_program_session%' AND pid<>pg_backend_pid()"
			)
		).rows[0].n as number;
	it("returns safe 503 within the shared budget when Mini token SQL waits on a lock", async () => {
		const blocker = await admin.connect();
		try {
			await blocker.query("BEGIN");
			await blocker.query("LOCK TABLE bauth.mini_program_session IN ACCESS EXCLUSIVE MODE");
			const start = performance.now();
			const response = await fetch(url + "/graphql", {
				method: "POST",
				headers: headers(),
				body: JSON.stringify({ query: "query { events { id } }" }),
				signal: AbortSignal.timeout(14000),
			});
			const body = (await response.json()) as {
				errors?: Array<{ extensions?: { code?: string } }>;
			};
			expect(response.status).toBe(503);
			expect(body.errors?.[0]?.extensions?.code).toBe("DEPENDENCY_UNAVAILABLE");
			expect(performance.now() - start).toBeGreaterThan(11000);
			expect(performance.now() - start).toBeLessThan(13500);
			expect(await miniActive()).toBe(0);
		} finally {
			await blocker.query("ROLLBACK");
			blocker.release();
		}
	}, 16000);
	it("stops active authentication SQL when the HTTP client disconnects", async () => {
		const blocker = await admin.connect();
		try {
			await blocker.query("BEGIN");
			await blocker.query("LOCK TABLE bauth.mini_program_session IN ACCESS EXCLUSIVE MODE");
			const controller = new AbortController();
			const response = fetch(url + "/graphql", {
				method: "POST",
				headers: headers(),
				body: JSON.stringify({ query: "query { events { id } }" }),
				signal: controller.signal,
			}).catch((error: unknown) => error);
			for (let i = 0; i < 30 && (await miniActive()) === 0; i++) await Bun.sleep(20);
			expect(await miniActive()).toBe(1);
			controller.abort();
			await response;
			for (let i = 0; i < 30 && (await miniActive()) !== 0; i++) await Bun.sleep(20);
			expect(await miniActive()).toBe(0);
		} finally {
			await blocker.query("ROLLBACK");
			blocker.release();
		}
	});
});
