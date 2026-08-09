import { GraphQLError } from "graphql";
import type { GraphQLContext } from "../graphql/context";
import type { QueryExecutor } from "./database";

export type CurrentSeason = Readonly<{
	seasonId: number;
	seasonCode: string;
}>;

type CurrentSeasonRow = {
	season_id: number;
	season_code: string;
};

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
			`SELECT season_id, season_code
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
	if (!Number.isInteger(row.season_id) || row.season_id < 2000 || !seasonCode) {
		throw unavailable();
	}
	return { seasonId: row.season_id, seasonCode };
};

export class CurrentSeasonProvider {
	private cached: { value: CurrentSeason; expiresAt: number } | null = null;
	private inFlight: Promise<CurrentSeason> | null = null;

	constructor(
		private readonly database: QueryExecutor,
		private readonly ttlMs = 30_000
	) {}

	async get(options: { force?: boolean } = {}): Promise<CurrentSeason> {
		const now = Date.now();
		if (!options.force && this.cached && this.cached.expiresAt > now) return this.cached.value;
		if (!options.force && this.inFlight) return this.inFlight;

		const request = loadCurrentSeason(this.database).then((value) => {
			this.cached = { value, expiresAt: Date.now() + this.ttlMs };
			return value;
		});
		this.inFlight = request;
		try {
			return await request;
		} finally {
			if (this.inFlight === request) this.inFlight = null;
		}
	}

	seed(value: CurrentSeason): void {
		this.cached = { value, expiresAt: Date.now() + this.ttlMs };
	}
}

export const getCurrentSeasonRef = async (context: GraphQLContext): Promise<CurrentSeason> =>
	context.currentSeason;

export const getCurrentSeason = async (context: GraphQLContext): Promise<string> =>
	context.currentSeason.seasonCode;
