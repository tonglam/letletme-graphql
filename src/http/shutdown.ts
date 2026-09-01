export type ShutdownServer = {
	stop: (force?: boolean) => Promise<void> | void;
};

export type ShutdownResult = Readonly<{
	forced: boolean;
	failed: boolean;
}>;

const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;

const withDrainTimeout = async (server: ShutdownServer, timeoutMs: number): Promise<boolean> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			Promise.resolve(server.stop()),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("server drain timed out")), timeoutMs);
			}),
		]);
		return false;
	} catch {
		return true;
	} finally {
		if (timer) clearTimeout(timer);
	}
};

export const createShutdownHandler = ({
	server,
	stopApollo,
	flushTelemetry,
	closeRedis,
	closeDbPool,
	drainTimeoutMs,
	setExitCode = (code: number): void => {
		process.exitCode = code;
	},
	exitProcess = (code: number): void => {
		process.exit(code);
	},
	log = (): void => {},
}: {
	server: ShutdownServer;
	stopApollo: () => Promise<void>;
	flushTelemetry?: () => Promise<void>;
	closeRedis: () => Promise<void>;
	closeDbPool: () => Promise<void>;
	drainTimeoutMs?: number;
	setExitCode?: (code: number) => void;
	exitProcess?: (code: number) => void;
	log?: (error?: unknown) => void;
}): ((signal: string) => Promise<ShutdownResult>) => {
	let shutdownPromise: Promise<ShutdownResult> | null = null;
	return (signal: string): Promise<ShutdownResult> => {
		if (shutdownPromise) return shutdownPromise;
		shutdownPromise = (async (): Promise<ShutdownResult> => {
			log({ signal });
			let failed = false;
			const forced = await withDrainTimeout(server, drainTimeoutMs ?? SHUTDOWN_DRAIN_TIMEOUT_MS);
			if (forced) {
				failed = true;
				try {
					await server.stop(true);
				} catch (error) {
					failed = true;
					log(error);
				}
			}
			if (flushTelemetry) {
				try {
					await flushTelemetry();
				} catch (error) {
					failed = true;
					log({ dependency: "rate-limit-telemetry", error });
				}
			}
			for (const [dependency, close] of [
				["apollo", stopApollo],
				["redis", closeRedis],
				["postgres", closeDbPool],
			] as const) {
				try {
					await close();
				} catch (error) {
					failed = true;
					log({ dependency, error });
				}
			}
			const exitCode = failed ? 1 : 0;
			setExitCode(exitCode);
			exitProcess(exitCode);
			return { forced, failed };
		})();
		return shutdownPromise;
	};
};
