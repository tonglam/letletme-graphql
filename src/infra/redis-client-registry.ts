export type RedisClientRole = "primary" | "rate-limit";

export type ManagedRedisConnection = {
	readonly status: string;
	connect(): Promise<unknown>;
	quit(): Promise<unknown>;
};

export class RedisClientRegistry<T extends ManagedRedisConnection> {
	private primaryClient: T | null = null;
	private rateLimitClient: T | null = null;

	constructor(
		private readonly endpoints: Readonly<{ primary: string; rateLimit: string }>,
		private readonly createClient: (url: string, role: RedisClientRole) => T
	) {}

	getPrimary(): T {
		if (!this.primaryClient) {
			this.primaryClient = this.createClient(this.endpoints.primary, "primary");
		}
		return this.primaryClient;
	}

	/** Keep security admission isolated from publication and query-cache bursts. */
	getRateLimit(): T {
		if (!this.rateLimitClient) {
			this.rateLimitClient = this.createClient(this.endpoints.rateLimit, "rate-limit");
		}
		return this.rateLimitClient;
	}

	async connectAll(): Promise<T> {
		const primary = this.getPrimary();
		const rateLimit = this.getRateLimit();
		await Promise.all([this.connect(primary), this.connect(rateLimit)]);
		return primary;
	}

	async closeAll(): Promise<void> {
		const clients = [this.primaryClient, this.rateLimitClient].filter(
			(value): value is T => value !== null
		);
		this.primaryClient = null;
		this.rateLimitClient = null;
		await Promise.all(clients.map((current) => current.quit()));
	}

	private async connect(redis: T): Promise<void> {
		if (redis.status === "end" || redis.status === "wait") {
			await redis.connect();
		}
	}
}
