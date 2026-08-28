/**
 * Read an environment value without eagerly constructing the validated runtime
 * configuration.  Lightweight adapters (for example provider clients and
 * isolated unit tests) use this to avoid making unrelated required settings
 * such as DATABASE_URL a module-import prerequisite.
 */
export const readRuntimeEnv = (key: string): string | undefined => {
	const value = typeof Bun !== "undefined" ? Bun.env[key] : undefined;
	if (value !== undefined) return value;
	return process.env[key];
};
