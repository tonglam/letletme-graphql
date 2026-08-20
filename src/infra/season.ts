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

	private static sameIdentity(
		left: Pick<CurrentSeason, "seasonId" | "seasonCode">,
		right: Pick<CurrentSeason, "seasonId" | "seasonCode">
	): boolean {
		return left.seasonId === right.seasonId && left.seasonCode === right.seasonCode;
	}

	get(): CurrentSeason {
		if (!this.value) throw unavailable();
		return this.value;
	}

	seed(value: CurrentSeason): void {
		this.value = Object.freeze({ ...value });
		this.refreshedAt = Date.now();
	}

	/**
	 * Revalidate the mutable season lifecycle on a short process-local interval.
	 *
	 * Request contexts are built with a ReadModelClient and authorization bound
	 * to one season identity. A lifecycle refresh may update that identity's
	 * state, but must never switch a request to a newly promoted season halfway
	 * through a multi-root operation. Callers can pass the request-pinned
	 * identity to make that boundary explicit.
	 */
	async refresh(
		database: QueryExecutor,
		maxAgeMs = 5_000,
		pinnedIdentity?: Pick<CurrentSeason, "seasonId" | "seasonCode" | "lifecycleState">
	): Promise<CurrentSeason> {
		if (this.value && Date.now() - this.refreshedAt < maxAgeMs) {
			return pinnedIdentity && !CurrentSeasonProvider.sameIdentity(this.value, pinnedIdentity)
				? pinnedIdentity
				: this.value;
		}
		if (!this.refreshPromise) {
			this.refreshPromise = loadCurrentSeason(database)
				.then((value) => {
					// Always advance the process-level provider to the authority's
					// latest season. A caller with an older request pin is mapped back
					// to that identity below, while future requests see this value.
					this.seed(value);
					return value;
				})
				.finally(() => {
					this.refreshPromise = null;
				});
		}
		const refreshed = await this.refreshPromise;
		return pinnedIdentity && !CurrentSeasonProvider.sameIdentity(refreshed, pinnedIdentity)
			? pinnedIdentity
			: refreshed;
	}
}

export const getCurrentSeasonRef = async (context: GraphQLContext): Promise<CurrentSeason> =>
	context.currentSeason;

export const getCurrentSeason = async (context: GraphQLContext): Promise<string> =>
	context.currentSeason.seasonCode;
