import { randomUUID } from "crypto";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const OPERATION_NAME_PATTERN = /^[_A-Za-z][_0-9A-Za-z]{0,127}$/;

export class RequestTiming {
	private readonly durations = new Map<string, number>();
	private readonly startedAt: number;

	constructor(private readonly now: () => number = () => performance.now()) {
		this.startedAt = this.now();
	}

	start(stage: string): () => void {
		const startedAt = this.now();
		let stopped = false;
		return () => {
			if (stopped) return;
			stopped = true;
			this.record(stage, this.now() - startedAt);
		};
	}

	record(stage: string, durationMs: number): void {
		const previous = this.durations.get(stage) ?? 0;
		this.durations.set(stage, previous + Math.max(0, durationMs));
	}

	async measure<T>(stage: string, task: () => Promise<T>): Promise<T> {
		const stop = this.start(stage);
		try {
			return await task();
		} finally {
			stop();
		}
	}

	measureSync<T>(stage: string, task: () => T): T {
		const stop = this.start(stage);
		try {
			return task();
		} finally {
			stop();
		}
	}

	elapsedMs(): number {
		return Math.max(0, this.now() - this.startedAt);
	}

	snapshot(): Record<string, number> {
		return Object.fromEntries(
			Array.from(this.durations, ([stage, durationMs]) => [stage, Number(durationMs.toFixed(2))])
		);
	}
}

export const resolveRequestId = (
	provided: string | null,
	generate: () => string = randomUUID
): string => (provided && REQUEST_ID_PATTERN.test(provided) ? provided : generate());

export const extractGraphQLOperationName = (body: unknown): string => {
	if (!body || typeof body !== "object" || Array.isArray(body)) return "anonymous";
	const operationName = (body as { operationName?: unknown }).operationName;
	return typeof operationName === "string" && OPERATION_NAME_PATTERN.test(operationName)
		? operationName
		: "anonymous";
};
