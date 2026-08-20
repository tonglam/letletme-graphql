import { GraphQLError } from "graphql";
import type { GraphQLContext } from "../graphql/context";
import type { QueryExecutor } from "./database";

export type CurrentSeason = Readonly<{
	seasonId: number;
	seasonCode: string;
	lifecycleState?: "reference_only" | "completed" | "preseason" | "active" | "closed";
}>;

type CurrentSeasonRow = {
	season_id: number;
	season_code: string;
	lifecycle_state?: string;
};

const CURRENT_SEASON_LIFECYCLE_STATES = [
	"reference_only",
	"completed",
	"preseason",
	"active",
	"closed",
] as const;

export const parseSeason = (value: string | null): string | null => {
	if (!value) return null;
	const trimmed = value.trim();
	return /^\d{4}$/.test(trimmed) ? trimmed : null;
};

const unavailable = (cause?: unknown): GraphQLError =>
	new GraphQLError("Current season metadata is unavailable", {
		extensions: {
			code: "DATABASE_METADATA_UNAVAILABLE",
			http: { status: 503 },
			...(cause === undefined ? {} : { cause }),
		},
	});

export const loadCurrentSeason = async (database: QueryExecutor): Promise<CurrentSeason> => {
	let rows: CurrentSeasonRow[];
	try {
		const result = await database.query<CurrentSeasonRow>(
			`SELECT season_id, season_code, lifecycle_state
			 FROM fpl.seasons
			 WHERE is_current = TRUE
			 ORDER BY season_id
			 LIMIT 2`
		);
		rows = result.rows;
	} catch (error) {
		throw unavailable(error);
	}

	if (rows.length !== 1) throw unavailable();
	const row = rows[0];
	const seasonCode = parseSeason(row.season_code);
	const lifecycleState = row.lifecycle_state;
	if (!Number.isInteger(row.season_id) || row.season_id < 2000 || !seasonCode) {
		throw unavailable();
	}
	if (
		lifecycleState !== undefined &&
		!CURRENT_SEASON_LIFECYCLE_STATES.includes(
			lifecycleState as (typeof CURRENT_SEASON_LIFECYCLE_STATES)[number]
		)
	) {
		throw unavailable();
	}
	return {
		seasonId: row.season_id,
		seasonCode,
		...(lifecycleState === undefined
			? {}
			: { lifecycleState: lifecycleState as CurrentSeason["lifecycleState"] }),
	};
};

export class CurrentSeasonProvider {
	private value: CurrentSeason | null = null;
	private refreshedAt = 0;
	private refreshPromise: Promise<CurrentSeason> | null = null;

	get(): CurrentSeason {
		if (!this.value) throw unavailable();
		return this.value;
	}

	seed(value: CurrentSeason): void {
		this.value = Object.freeze({ ...value });
		this.refreshedAt = Date.now();
	}

	/** Revalidate the mutable season lifecycle on a short process-local interval. */
	async refresh(database: QueryExecutor, maxAgeMs = 5_000): Promise<CurrentSeason> {
		if (this.value && Date.now() - this.refreshedAt < maxAgeMs) return this.value;
		if (this.refreshPromise) return this.refreshPromise;
		this.refreshPromise = loadCurrentSeason(database)
			.then((value) => {
				this.seed(value);
				return value;
			})
			.finally(() => {
				this.refreshPromise = null;
			});
		return this.refreshPromise;
	}
}

export const getCurrentSeasonRef = async (context: GraphQLContext): Promise<CurrentSeason> =>
	context.currentSeason;

export const getCurrentSeason = async (context: GraphQLContext): Promise<string> =>
	context.currentSeason.seasonCode;
