import { createHash } from "crypto";
import { dbPool } from "./db-pool";
import { logger } from "./logger";
import { isLegacyAuthValidationOpen, type AuthUser } from "./principal";

type DeviceSessionUserRow = {
	user_id: string;
	device_id: string;
	email: string | null;
	name: string | null;
	emailVerified: boolean | null;
	image: string | null;
	isAnonymous: boolean | null;
};

export const hashDeviceToken = (token: string): string =>
	createHash("sha256").update(token).digest("hex");

/** Validation-only bridge for already-issued device tokens during the grace window. */
export async function validateDeviceToken(token: string): Promise<AuthUser | null> {
	if (!isLegacyAuthValidationOpen()) return null;

	const tokenHash = hashDeviceToken(token);
	const result = await dbPool.query<DeviceSessionUserRow>(
		`SELECT
         ds.user_id,
         ds.device_id,
         u.email,
         u.name,
         u."emailVerified",
         u.image,
         u."isAnonymous"
       FROM device_sessions ds
       JOIN "user" u ON ds.user_id = u.id
       WHERE ds.token_hash = $1 AND ds.expires_at > NOW()`,
		[tokenHash]
	);

	const row = result.rows[0];
	if (!row) return null;

	void dbPool
		.query("UPDATE device_sessions SET last_active = NOW() WHERE token_hash = $1", [tokenHash])
		.catch((err: unknown) => {
			logger.warn({ err }, "Failed to update device session last_active");
		});

	return {
		id: row.user_id,
		email: row.email,
		name: row.name,
		emailVerified: row.emailVerified ?? false,
		image: row.image,
		isAnonymous: row.isAnonymous ?? false,
		deviceId: row.device_id,
		fplEntryId: null,
		fplEntryVerifiedAt: null,
	};
}
