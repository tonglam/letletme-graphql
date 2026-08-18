import type Redis from "ioredis";
import type { QueryExecutor } from "../../infra/database";
import {
	readBriefingWeek,
	type BriefingLocale,
	type BriefingWeekRead,
} from "../../infra/content-publication";

export type BriefingRepository = {
	readWeek(
		database: QueryExecutor,
		redis: Redis,
		locale: BriefingLocale
	): Promise<BriefingWeekRead>;
};

export const briefingRepository: BriefingRepository = {
	readWeek: (database, redis, locale) => readBriefingWeek(database, redis, locale),
};
