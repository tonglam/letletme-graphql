import { AsyncLocalStorage } from "node:async_hooks";

/** Absolute, shared request budget; no query text or caller identity is retained. */
export class ExecutionExpiredError extends Error {
	constructor(readonly reason: "deadline" | "cancelled" | "finished") {
		super("Dependency execution is no longer available");
		this.name = "ExecutionExpiredError";
	}
}

export const REQUEST_DATABASE_BUDGET_MS = 12_000;
export const DATABASE_CLEANUP_BUDGET_MS = 1_000;

const executions = new AsyncLocalStorage<ExecutionScope>();

export class ExecutionScope {
	static current(): ExecutionScope | undefined {
		return executions.getStore();
	}
	run<T>(work: () => T): T {
		return executions.run(this, work);
	}
	private readonly cleanup = new Set<Promise<unknown>>();
	track(work: Promise<unknown>): void {
		const settled = work.then(
			() => undefined,
			() => undefined
		);
		this.cleanup.add(settled);
		void settled.then(() => this.cleanup.delete(settled));
	}
	async settleCleanup(): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			Promise.all([...this.cleanup]),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, DATABASE_CLEANUP_BUDGET_MS);
			}),
		]);
		clearTimeout(timer);
	}

	private readonly controller = new AbortController();
	private readonly timer: ReturnType<typeof setTimeout>;
	private readonly detachParent: () => void;
	readonly signal = this.controller.signal;

	constructor(
		readonly deadlineAt = Date.now() + REQUEST_DATABASE_BUDGET_MS,
		parent?: AbortSignal
	) {
		const abort = (): void => this.cancel("cancelled");
		parent?.addEventListener("abort", abort, { once: true });
		this.detachParent = () => parent?.removeEventListener("abort", abort);
		this.timer = setTimeout(() => this.cancel("deadline"), Math.max(0, deadlineAt - Date.now()));
		this.timer.unref();
		if (parent?.aborted) abort();
	}

	cancel(reason: "deadline" | "cancelled" | "finished" = "cancelled"): void {
		if (!this.signal.aborted) this.controller.abort(new ExecutionExpiredError(reason));
	}

	remainingMs(): number {
		if (Date.now() >= this.deadlineAt) this.cancel("deadline");
		if (this.signal.aborted) throw this.signal.reason;
		return Math.max(1, this.deadlineAt - Date.now());
	}

	/** Always observes late settlement, even when the caller has stopped waiting. */
	wait<T>(work: Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const abort = (): void => {
				this.signal.removeEventListener("abort", abort);
				reject(this.signal.reason);
			};
			this.signal.addEventListener("abort", abort, { once: true });
			work.then(
				(value) => {
					this.signal.removeEventListener("abort", abort);
					try {
						this.remainingMs();
						resolve(value);
					} catch (error) {
						reject(error);
					}
				},
				(error: unknown) => {
					this.signal.removeEventListener("abort", abort);
					reject(this.signal.aborted ? this.signal.reason : error);
				}
			);
			try {
				this.remainingMs();
			} catch (error) {
				reject(error);
			}
		});
	}

	/** Keep cancellation attached until the actual response body ends. */
	finishResponse(response: Response, onFinished?: () => void): Response {
		if (!response.body) {
			this.dispose();
			onFinished?.();
			return response;
		}
		const reader = response.body.getReader();
		let finished = false;
		let controller: ReadableStreamDefaultController<Uint8Array>;
		const finish = (): void => {
			if (finished) return;
			finished = true;
			this.signal.removeEventListener("abort", abort);
			this.dispose();
			onFinished?.();
		};
		const abort = (): void => {
			if (finished) return;
			controller.error(new ExecutionExpiredError("cancelled"));
			void reader.cancel().catch(() => undefined);
			finish();
		};
		const body = new ReadableStream<Uint8Array>({
			start: (value) => {
				controller = value;
				this.signal.addEventListener("abort", abort, { once: true });
				if (this.signal.aborted) abort();
			},
			pull: async () => {
				try {
					const result = await reader.read();
					if (finished) return;
					if (result.done) {
						controller.close();
						finish();
					} else controller.enqueue(result.value);
				} catch (error) {
					if (!finished) {
						controller.error(error);
						finish();
					}
				}
			},
			cancel: async () => {
				finish();
				await reader.cancel().catch(() => undefined);
			},
		});
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.detachParent();
		this.cancel("finished");
	}
}
