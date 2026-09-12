/** Absolute, shared request budget; no query text or caller identity is retained. */
export class ExecutionExpiredError extends Error {
	constructor(readonly reason: "deadline" | "cancelled" | "finished") {
		super("Dependency execution is no longer available");
		this.name = "ExecutionExpiredError";
	}
}

export const REQUEST_DATABASE_BUDGET_MS = 12_000;
export const DATABASE_CLEANUP_BUDGET_MS = 1_000;

export class ExecutionScope {
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
			const abort = (): void => reject(this.signal.reason);
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

	dispose(): void {
		clearTimeout(this.timer);
		this.detachParent();
		this.cancel("finished");
	}
}
