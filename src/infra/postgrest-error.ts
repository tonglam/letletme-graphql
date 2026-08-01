const errorText = (error: Record<string, unknown>): string =>
	[error.message, error.details, error.hint]
		.filter((value): value is string => typeof value === "string")
		.join(" ")
		.toLowerCase();

export const isMissingPostgrestColumnError = (error: unknown, column: string): boolean => {
	if (!error || typeof error !== "object" || Array.isArray(error)) return false;
	const record = error as Record<string, unknown>;
	const code = typeof record.code === "string" ? record.code : "";
	return (
		(code === "42703" || code === "PGRST204") && errorText(record).includes(column.toLowerCase())
	);
};
