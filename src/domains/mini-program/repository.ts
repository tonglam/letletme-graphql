import type { GraphQLContext } from "../../graphql/context";

/** Matches Java `StringUtils.joinWith("::", "MiniProgram", "Notice")` */
export const MINI_PROGRAM_NOTICE_REDIS_KEY = "MiniProgram::Notice";

export interface MiniProgramRepository {
	getMiniProgramNotice(context: GraphQLContext): Promise<string>;
}

export const miniProgramRepository: MiniProgramRepository = {
	async getMiniProgramNotice(context: GraphQLContext): Promise<string> {
		try {
			const map = await context.redis.hgetall(MINI_PROGRAM_NOTICE_REDIS_KEY);
			if (Object.keys(map).length === 0) {
				return "";
			}

			const switchRaw = map.switch;
			if (switchRaw === undefined || switchRaw.trim() === "") {
				return "";
			}
			if (switchRaw.toLowerCase() !== "on") {
				return "";
			}

			return map.content ?? "";
		} catch (err) {
			context.logger.warn(
				{ err, key: MINI_PROGRAM_NOTICE_REDIS_KEY },
				"Failed to read mini program notice from Redis",
			);
			return "";
		}
	},
};
