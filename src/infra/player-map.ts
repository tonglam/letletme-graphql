import type { GraphQLContext } from "../graphql/context";
import { getCurrentSeason } from "./season";
import type { Player } from "./types";

export async function buildPlayerMap(
	context: GraphQLContext,
	playerIds: number[],
): Promise<Map<number, Player>> {
	const result = new Map<number, Player>();
	if (playerIds.length === 0) return result;

	const season = await getCurrentSeason(context);
	const hashKey = `Player:${season}`;

	try {
		const values = await context.redis.hmget(hashKey, ...playerIds.map(String));
		const missingIds: number[] = [];

		for (let i = 0; i < playerIds.length; i++) {
			const value = values[i];
			if (value) {
				try {
					const parsed = JSON.parse(value) as Record<string, unknown>;
					result.set(playerIds[i], parsePlayer(parsed, playerIds[i]));
				} catch {
					missingIds.push(playerIds[i]);
				}
			} else {
				missingIds.push(playerIds[i]);
			}
		}

		if (missingIds.length > 0) {
			const { data, error } = await context.supabase
				.from("players")
				.select(
					"id, web_name, first_name, second_name, team_id, type, code, price, start_price",
				)
				.in("id", missingIds);

			if (!error && data) {
				for (const row of data as Record<string, unknown>[]) {
					const player = parsePlayerFromDb(row);
					result.set(player.id, player);
				}
			}
		}

		return result;
	} catch (err) {
		context.logger.warn(
			{ err, hashKey },
			"Failed to read Player hash from Redis, falling back to DB",
		);
	}

	const { data, error } = await context.supabase
		.from("players")
		.select(
			"id, web_name, first_name, second_name, team_id, type, code, price, start_price",
		)
		.in("id", playerIds);

	if (!error && data) {
		for (const row of data as Record<string, unknown>[]) {
			const player = parsePlayerFromDb(row);
			result.set(player.id, player);
		}
	}
	return result;
}

const asNullableNumber = (
	value: number | string | null | undefined,
): number | null => {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
};

function parsePlayer(parsed: Record<string, unknown>, id: number): Player {
	return {
		id,
		code: Number(parsed.code ?? 0),
		webName: String(parsed.webName ?? parsed.web_name ?? ""),
		firstName: parsed.firstName
			? String(parsed.firstName)
			: parsed.first_name
				? String(parsed.first_name)
				: null,
		secondName: parsed.secondName
			? String(parsed.secondName)
			: parsed.second_name
				? String(parsed.second_name)
				: null,
		teamId: Number(parsed.teamId ?? parsed.team_id ?? 0),
		position: Number(parsed.type ?? parsed.position ?? 0),
		price: Number(parsed.price ?? 0),
		startPrice: Number(parsed.startPrice ?? parsed.start_price ?? 0),
		totalPoints: Number(parsed.totalPoints ?? 0),
		selectedByPercent: asNullableNumber(
			(parsed.selectedByPercent ?? parsed.selected_by_percent) as
				| number
				| string
				| null
				| undefined,
		),
	};
}

function parsePlayerFromDb(row: Record<string, unknown>): Player {
	return {
		id: Number(row.id),
		code: Number(row.code ?? 0),
		webName: String(row.web_name ?? ""),
		firstName: row.first_name ? String(row.first_name) : null,
		secondName: row.second_name ? String(row.second_name) : null,
		teamId: Number(row.team_id ?? 0),
		position: Number(row.type ?? 0),
		price: Number(row.price ?? 0),
		startPrice: Number(row.start_price ?? 0),
		totalPoints: 0,
		selectedByPercent: null,
	};
}
