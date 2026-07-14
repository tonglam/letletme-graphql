import { betterAuth } from "better-auth";
import { dbPool } from "./db-pool";
import { env } from "./env";
import { logger } from "./logger";

let authInstance: ReturnType<typeof betterAuth>;

try {
	authInstance = betterAuth({
		database: dbPool,
		secret: env.BETTER_AUTH_SECRET,
		baseURL: env.BETTER_AUTH_URL,

		emailAndPassword: {
			enabled: true,
			minPasswordLength: 8,
			requireEmailVerification: false,
		},

		socialProviders: {
			google: {
				clientId: env.GOOGLE_CLIENT_ID,
				clientSecret: env.GOOGLE_CLIENT_SECRET,
				enabled: !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET,
			},
			apple: {
				clientId: env.APPLE_CLIENT_ID,
				clientSecret: env.APPLE_CLIENT_SECRET,
				enabled: !!env.APPLE_CLIENT_ID && !!env.APPLE_CLIENT_SECRET,
			},
		},

		session: {
			expiresIn: 60 * 60 * 24 * 7,
			cookieCache: {
				enabled: true,
				maxAge: 60 * 5,
			},
		},
	});

	logger.info("Better Auth initialized successfully");
} catch (error) {
	const errorMessage = error instanceof Error ? error.message : String(error);
	const errorStack = error instanceof Error ? error.stack : undefined;

	logger.error(
		{
			err: error,
			message: errorMessage,
			stack: errorStack,
		},
		"Better Auth initialization failed - check database connection and schema",
	);

	if (env.isProduction) {
		throw error instanceof Error
			? error
			: new Error("Better Auth initialization failed in production");
	}

	try {
		authInstance = betterAuth({
			database: dbPool,
			secret: env.BETTER_AUTH_SECRET,
			baseURL: env.BETTER_AUTH_URL,
			emailAndPassword: {
				enabled: false,
			},
		});
	} catch (fallbackError) {
		logger.error(
			{ err: fallbackError },
			"Failed to create fallback auth instance - auth features will be unavailable",
		);
		authInstance = betterAuth({
			database: dbPool,
			secret: env.BETTER_AUTH_SECRET,
			baseURL: env.BETTER_AUTH_URL,
		});
	}
}

export const auth = authInstance;

export interface AuthUser {
	id: string;
	email: string | null;
	name: string | null;
	emailVerified: boolean;
	image?: string | null;
	isAnonymous?: boolean;
	deviceId?: string | null;
	openid?: string | null;
	fplEntryId?: number | null;
}

export async function getUserFromSession(
	headers: Headers,
): Promise<AuthUser | null> {
	try {
		const session = await auth.api.getSession({ headers });

		if (!session?.user) {
			return null;
		}

		return {
			id: session.user.id,
			email: session.user.email,
			name: session.user.name,
			emailVerified: session.user.emailVerified,
			image: session.user.image,
			isAnonymous: false,
		};
	} catch (error) {
		logger.warn({ err: error }, "Failed to get user from session");
		return null;
	}
}

/**
 * Look up fpl_entry_id for a Better Auth / website user id.
 */
export async function getFplEntryIdForUser(
	userId: string,
): Promise<number | null> {
	const result = await dbPool.query<{ fpl_entry_id: number | null }>(
		`SELECT fpl_entry_id FROM bauth."user" WHERE id = $1 LIMIT 1`,
		[userId],
	);
	return result.rows[0]?.fpl_entry_id ?? null;
}
