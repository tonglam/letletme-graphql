import { createHash } from "crypto";
import type { AuthUser } from "./auth";
import { dbPool } from "./db-pool";
import { logger } from "./logger";

interface DeviceInfo {
	name?: string;
	os?: string;
}

interface DeviceAuthResult {
	token: string;
	userId: string;
	isAnonymous: boolean;
}

type UserDeviceRow = {
	id: string;
	isAnonymous: boolean | null;
};

type DeviceSessionUserRow = {
	user_id: string;
	device_id: string;
	email: string | null;
	name: string | null;
	emailVerified: boolean | null;
	image: string | null;
	isAnonymous: boolean | null;
};

type DeviceUserRow = {
	id: string;
};

type DeviceSessionRow = {
	id: string;
	device_id: string;
	device_name: string | null;
	device_os: string | null;
	last_active: Date;
	created_at: Date;
};

export const hashDeviceToken = (token: string): string =>
	createHash("sha256").update(token).digest("hex");

/**
 * Authenticate a device and return a session token.
 * Creates an anonymous user if the device is new.
 * The plaintext token is returned once; only the SHA-256 hash is stored.
 */
export async function authenticateDevice(
	deviceId: string,
	deviceInfo?: DeviceInfo,
): Promise<DeviceAuthResult> {
	const client = await dbPool.connect();

	try {
		await client.query("BEGIN");

		const existingUser = await client.query<UserDeviceRow>(
			'SELECT id, "isAnonymous" FROM "user" WHERE "deviceId" = $1',
			[deviceId],
		);

		let userId: string;
		let isAnonymous: boolean;

		if (existingUser.rows.length > 0) {
			const row = existingUser.rows[0];
			if (!row) throw new Error("Expected row after length check");
			userId = row.id;
			isAnonymous = row.isAnonymous ?? false;
		} else {
			userId = crypto.randomUUID();

			await client.query(
				`INSERT INTO "user" (id, "deviceId", "isAnonymous", "createdAt", "updatedAt")
         VALUES ($1, $2, true, NOW(), NOW())`,
				[userId, deviceId],
			);

			isAnonymous = true;
		}

		const token = crypto.randomUUID();
		const tokenHash = hashDeviceToken(token);
		const expiresAt = new Date();
		expiresAt.setFullYear(expiresAt.getFullYear() + 1);

		await client.query(
			`INSERT INTO device_sessions
       (id, user_id, device_id, device_name, device_os, token, token_hash, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, NOW())
       ON CONFLICT (device_id) DO UPDATE SET
         token = NULL,
         token_hash = EXCLUDED.token_hash,
         last_active = NOW(),
         expires_at = EXCLUDED.expires_at,
         device_name = COALESCE(EXCLUDED.device_name, device_sessions.device_name),
         device_os = COALESCE(EXCLUDED.device_os, device_sessions.device_os)`,
			[
				crypto.randomUUID(),
				userId,
				deviceId,
				deviceInfo?.name ?? null,
				deviceInfo?.os ?? null,
				tokenHash,
				expiresAt,
			],
		);

		await client.query("COMMIT");

		return { token, userId, isAnonymous };
	} catch (error) {
		try {
			await client.query("ROLLBACK");
		} catch {
			/* ignore rollback errors on broken connections */
		}
		throw error;
	} finally {
		client.release();
	}
}

/**
 * Validate a device token and return user info.
 */
export async function validateDeviceToken(
	token: string,
): Promise<AuthUser | null> {
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
		[tokenHash],
	);

	if (result.rows.length === 0) {
		return null;
	}

	const row = result.rows[0];

	// Use pool.query (no checked-out client) so last_active updates never race release().
	void dbPool
		.query("UPDATE device_sessions SET last_active = NOW() WHERE token_hash = $1", [
			tokenHash,
		])
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
	};
}

/**
 * Link an anonymous device user to an email/OAuth account.
 */
export async function linkDeviceToAccount(
	deviceId: string,
	email: string,
): Promise<void> {
	const client = await dbPool.connect();

	try {
		await client.query("BEGIN");

		const deviceUser = await client.query<DeviceUserRow>(
			'SELECT id FROM "user" WHERE "deviceId" = $1 AND "isAnonymous" = true',
			[deviceId],
		);

		if (deviceUser.rows.length === 0) {
			throw new Error("Device user not found or already linked");
		}

		const userId = deviceUser.rows[0].id;

		await client.query(
			`UPDATE "user"
       SET email = $1, "isAnonymous" = false, "linkedAt" = NOW(), "updatedAt" = NOW()
       WHERE id = $2`,
			[email, userId],
		);

		await client.query("COMMIT");
	} catch (error) {
		try {
			await client.query("ROLLBACK");
		} catch {
			/* ignore */
		}
		throw error;
	} finally {
		client.release();
	}
}

/**
 * Revoke a device session by plaintext token.
 */
export async function revokeDeviceToken(token: string): Promise<void> {
	const tokenHash = hashDeviceToken(token);
	await dbPool.query("DELETE FROM device_sessions WHERE token_hash = $1", [
		tokenHash,
	]);
}

/**
 * Get all device sessions for a user.
 */
export async function getUserDevices(userId: string): Promise<
	Array<{
		id: string;
		deviceId: string;
		deviceName: string | null;
		deviceOs: string | null;
		lastActive: Date;
		createdAt: Date;
	}>
> {
	const result = await dbPool.query<DeviceSessionRow>(
		`SELECT id, device_id, device_name, device_os, last_active, created_at
       FROM device_sessions
       WHERE user_id = $1 AND expires_at > NOW()
       ORDER BY last_active DESC`,
		[userId],
	);

	return result.rows.map((row) => ({
		id: row.id,
		deviceId: row.device_id,
		deviceName: row.device_name,
		deviceOs: row.device_os,
		lastActive: row.last_active,
		createdAt: row.created_at,
	}));
}
