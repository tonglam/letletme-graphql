import { EventEmitter } from "node:events";
import postgres from "postgres";
import { types, type QueryResultRow } from "pg";
import { env } from "./env";
import { logger } from "./logger";
import { postgresPoolErrors } from "./metrics";

export type DatabaseResult<Row extends QueryResultRow = QueryResultRow> = {
	rows: Row[];
	rowCount: number | null;
};
export type DatabaseClient = {
	query<Row extends QueryResultRow = QueryResultRow>(
		text: string,
		values?: readonly unknown[]
	): Promise<DatabaseResult<Row>>;
	cancel(): Promise<void>;
	release(destroy?: boolean): Promise<void>;
};

// Preserve pg's text parameter semantics, including nested arrays, nulls and
// dates. Parameters always use an inferred server type; no SQL interpolation.
const parameterText = (value: unknown): string => {
	if (Array.isArray(value))
		return `{${value.map((item) => (item === null || item === undefined ? "NULL" : Array.isArray(item) ? parameterText(item) : `"${parameterText(item).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`)).join(",")}}`;
	if (value instanceof Date) {
		const offset = -value.getTimezoneOffset();
		const local = new Date(value.getTime() + offset * 60_000).toISOString().slice(0, -1);
		return `${local}${offset < 0 ? "-" : "+"}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}:${String(Math.abs(offset) % 60).padStart(2, "0")}`;
	}
	if (Buffer.isBuffer(value)) return `\\x${value.toString("hex")}`;
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
};

type Slot = {
	sql: postgres.Sql;
	busy: boolean;
	retiring: boolean;
	idleTimer?: ReturnType<typeof setTimeout>;
	retirement?: Promise<void>;
};
type Checkout = {
	done: boolean;
	timer: ReturnType<typeof setTimeout>;
	resolve: (client: DatabaseClient) => void;
	reject: (error: Error) => void;
};

export type DatabasePoolErrorCategory = "server_shutdown" | "connection" | "other";

/** Keep the bounded metric useful even when the driver only reports a close. */
export const databasePoolErrorCategory = (error: unknown): DatabasePoolErrorCategory => {
	const code =
		error && typeof error === "object" && "code" in error && typeof error.code === "string"
			? error.code
			: undefined;
	if (code === "57P01" || code === "57P02" || code === "57P03") return "server_shutdown";
	if (
		code === "ECONNRESET" ||
		code === "EPIPE" ||
		code === "ETIMEDOUT" ||
		code === "ENOTFOUND" ||
		code?.startsWith("CONNECTION_") ||
		code === "CONNECT_TIMEOUT"
	)
		return "connection";
	return "other";
};

/** One max:1 driver per slot lets public end({timeout:0}) discard only the
 * damaged connection. This pool owns a single FIFO and the existing 1–4 cap;
 * there is no second business pool and no retry of application queries. */
export class DatabasePool extends EventEmitter {
	private readonly slots = new Set<Slot>();
	private readonly queue: Checkout[] = [];
	private ending = false;
	constructor(
		private readonly options: {
			connectionString: string;
			max: number;
			connectionTimeoutMillis?: number;
			idleTimeoutMillis?: number;
		}
	) {
		super();
		this.on("error", (error: Error) => {
			const category = databasePoolErrorCategory(error);
			postgresPoolErrors.labels(category).inc();
			logger.warn({ category }, "PostgreSQL connection removed after pool error");
		});
	}
	get totalCount(): number {
		return this.slots.size;
	}
	get idleCount(): number {
		return [...this.slots].filter((slot) => !slot.busy && !slot.retiring).length;
	}
	get waitingCount(): number {
		return this.queue.filter((entry) => !entry.done).length;
	}

	connect(): Promise<DatabaseClient> {
		if (this.ending) return Promise.reject(new Error("Database pool is closed"));
		return new Promise((resolve, reject) => {
			const checkout: Checkout = {
				done: false,
				resolve,
				reject,
				timer: setTimeout(() => {
					checkout.done = true;
					const index = this.queue.indexOf(checkout);
					if (index !== -1) this.queue.splice(index, 1);
					reject(
						Object.assign(new Error("Database connection acquisition timed out"), {
							code: "POOL_TIMEOUT",
						})
					);
				}, this.options.connectionTimeoutMillis ?? 2_000),
			};
			this.queue.push(checkout);
			this.dispatch();
		});
	}

	private dispatch(): void {
		while (!this.ending && this.queue.length > 0) {
			let slot = [...this.slots].find((candidate) => !candidate.busy && !candidate.retiring);
			if (!slot && this.slots.size >= this.options.max) return;
			if (!slot) {
				const created = { busy: false, retiring: false } as Slot;
				created.sql = postgres(this.options.connectionString, {
					max: 1,
					prepare: false,
					fetch_types: false,
					idle_timeout: 0,
					max_lifetime: null,
					connect_timeout: (this.options.connectionTimeoutMillis ?? 2_000) / 1000,
					connection: { application_name: "letletme-graphql" },
					types: Object.fromEntries(
						[0, ...Object.values(types.builtins)].map((oid) => [
							String(oid),
							{ to: oid, from: [], serialize: String, parse: String },
						])
					),
					onnotice: () => {},
					onclose: (_connectionId, error) => {
						if (!created.retiring) {
							this.emit(
								"error",
								error instanceof Error
									? error
									: new Error("Database connection closed unexpectedly")
							);
							void this.retire(created);
						}
					},
				});
				this.slots.add(created);
				slot = created;
			}
			const checkout = this.queue.shift()!;
			if (checkout.done) continue;
			slot.busy = true;
			clearTimeout(slot.idleTimer);
			void this.acquire(slot, checkout);
		}
	}

	private async acquire(slot: Slot, checkout: Checkout): Promise<void> {
		try {
			const reserved = slot.sql;
			let active: ReturnType<postgres.Sql["unsafe"]> | undefined;
			let released = false;
			const client: DatabaseClient = {
				query: async <Row extends QueryResultRow>(
					text: string,
					values: readonly unknown[] = []
				): Promise<DatabaseResult<Row>> => {
					if (released || slot.retiring) throw new Error("Database connection is closed");
					const query = reserved.unsafe(
						text,
						values.map((value) =>
							reserved.typed(value === null || value === undefined ? null : parameterText(value), 0)
						)
					);
					active = query;
					try {
						const result = await query.raw();
						return {
							rows: result.map((row) =>
								Object.fromEntries(
									result.columns.map((column, i) => [
										column.name,
										row[i] === null
											? null
											: (types.getTypeParser(column.type) as (text: string) => unknown)(
													row[i].toString("utf8")
												),
									])
								)
							) as Row[],
							rowCount: result.count,
						};
					} catch (error) {
						const code =
							error &&
							typeof error === "object" &&
							"code" in error &&
							typeof error.code === "string"
								? error.code
								: "DATABASE_QUERY_FAILED";
						throw Object.assign(new Error("Database operation failed"), { code });
					} finally {
						if (active === query) active = undefined;
					}
				},
				cancel: async () => {
					await active?.cancel();
				},
				release: async (destroy = false) => {
					if (released) return;
					released = true;
					if (destroy || slot.retiring || this.ending) {
						await this.retire(slot);
						return;
					}
					slot.busy = false;
					slot.idleTimer = setTimeout(() => {
						void this.retire(slot);
					}, this.options.idleTimeoutMillis ?? 30_000);
					slot.idleTimer.unref();
					this.dispatch();
				},
			};
			if (checkout.done || this.ending || slot.retiring) {
				await client.release(true);
				return;
			}
			checkout.done = true;
			clearTimeout(checkout.timer);
			checkout.resolve(client);
		} catch {
			clearTimeout(checkout.timer);
			if (!checkout.done) {
				checkout.done = true;
				checkout.reject(
					Object.assign(new Error("Database connection unavailable"), {
						code: "POOL_UNAVAILABLE",
					})
				);
			}
			await this.retire(slot);
		}
	}

	private retire(slot: Slot): Promise<void> {
		if (slot.retirement) return slot.retirement;
		slot.retiring = true;
		clearTimeout(slot.idleTimer);
		slot.retirement = (async () => {
			try {
				await slot.sql.end({ timeout: 0 });
			} catch {
				this.emit("error", new Error("Database connection cleanup failed"));
			} finally {
				this.slots.delete(slot);
				this.dispatch();
			}
		})();
		return slot.retirement;
	}
	async end(): Promise<void> {
		this.ending = true;
		for (const checkout of this.queue.splice(0)) {
			clearTimeout(checkout.timer);
			if (!checkout.done) {
				checkout.done = true;
				checkout.reject(new Error("Database pool is closed"));
			}
		}
		await Promise.all([...this.slots].map((slot) => this.retire(slot)));
	}
}

export const dbPool = new DatabasePool({
	connectionString: env.DATABASE_URL,
	max: env.DATABASE_POOL_MAX,
	idleTimeoutMillis: 30_000,
	connectionTimeoutMillis: 2_000,
});
export const closeDbPool = async (): Promise<void> => {
	await dbPool.end();
};
