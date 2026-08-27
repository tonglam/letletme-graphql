/** Canonical chip values shared by every FPL-facing projection. */
export type CanonicalFplChip =
	"NONE" | "BENCH_BOOST" | "TRIPLE_CAPTAIN" | "FREE_HIT" | "WILDCARD" | "MANAGER";

type ChipFallback = CanonicalFplChip | null;

/**
 * Normalize the spelling variants emitted by FPL/Data into one GraphQL-safe
 * value. Callers choose the fallback because cache codecs distinguish an
 * unknown value (null) from an explicit no-chip value (NONE).
 */
export const normalizeFplChip = (
	raw: unknown,
	fallback: ChipFallback = "NONE",
	options: { emptyAsNone?: boolean } = {}
): ChipFallback => {
	if (typeof raw !== "string") return fallback;
	const value = raw.toUpperCase().trim();
	const compact = value.replace(/[^A-Z0-9]/g, "");
	if (
		value === "BENCH_BOOST" ||
		compact === "BENCHBOOST" ||
		compact === "BBOOST" ||
		compact === "BB"
	)
		return "BENCH_BOOST";
	if (
		value === "TRIPLE_CAPTAIN" ||
		compact === "TRIPLECAPTAIN" ||
		compact === "3XC" ||
		compact === "TC"
	)
		return "TRIPLE_CAPTAIN";
	if (value === "FREE_HIT" || compact === "FREEHIT" || compact === "FH") return "FREE_HIT";
	if (value === "WILDCARD" || compact === "WILDCARD" || compact === "WC") return "WILDCARD";
	if (value === "MANAGER" || compact === "MANAGER" || compact === "AM") return "MANAGER";
	if (
		compact === "NONE" ||
		compact === "NOCHIP" ||
		(options.emptyAsNone !== false && (compact === "" || compact === "NA"))
	)
		return "NONE";
	return fallback;
};
