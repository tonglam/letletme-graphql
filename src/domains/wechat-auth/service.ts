import { dbPool } from "../../infra/db-pool";
import { env } from "../../infra/env";

interface WechatResponse {
	openid?: string;
	session_key?: string;
	errcode?: number;
	errmsg?: string;
}

type UserRow = {
	id: string;
	email: string | null;
	fpl_entry_id: number | null;
};

/**
 * Exchange a WeChat js_code for openid and ensure a miniprogram user row exists.
 * Does not bind arbitrary fplEntryId values (use authenticated bindFplEntry).
 * @deprecated Prefer createWechatApiSession for new clients.
 */
export async function identifyWechatUser(code: string): Promise<string> {
	const url =
		`https://api.weixin.qq.com/sns/jscode2session` +
		`?appid=${encodeURIComponent(env.WECHAT_APPID)}` +
		`&secret=${encodeURIComponent(env.WECHAT_APPSECRET)}` +
		`&js_code=${encodeURIComponent(code)}` +
		`&grant_type=authorization_code`;
	const res = await fetch(url);
	const data = (await res.json()) as WechatResponse;
	if (!data.openid) {
		throw new Error(`WeChat auth failed: ${data.errmsg ?? "unknown"}`);
	}
	const openid = data.openid;

	const client = await dbPool.connect();
	try {
		await client.query("BEGIN");

		const existing = await client.query<UserRow>(
			`SELECT id, email, fpl_entry_id FROM bauth."user" WHERE openid = $1 LIMIT 1`,
			[openid],
		);

		if (!existing.rows[0]) {
			await client.query(
				`INSERT INTO bauth."user" (id, openid, email_verified, created_at, updated_at)
         VALUES ($1, $2, false, NOW(), NOW())`,
				[crypto.randomUUID(), openid],
			);
		}

		await client.query("COMMIT");
		return openid;
	} catch (err) {
		try {
			await client.query("ROLLBACK");
		} catch {
			/* ignore */
		}
		throw err;
	} finally {
		client.release();
	}
}

export async function bindFplEntry(
	userId: string,
	fplEntryId: number,
): Promise<void> {
	if (!Number.isInteger(fplEntryId) || fplEntryId <= 0) {
		throw new Error("Invalid fplEntryId");
	}

	const client = await dbPool.connect();
	try {
		await client.query("BEGIN");

		const conflict = await client.query<{ id: string }>(
			`SELECT id FROM bauth."user"
       WHERE fpl_entry_id = $1 AND id <> $2
       LIMIT 1`,
			[fplEntryId, userId],
		);
		if (conflict.rows[0]) {
			throw new Error("FPL entry is already bound to another account");
		}

		await client.query(
			`UPDATE bauth."user"
       SET fpl_entry_id = $1, fpl_entry_bound_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
			[fplEntryId, userId],
		);

		const mpUser = await client.query<{ id: string; openid: string }>(
			`SELECT id, openid FROM bauth."user"
       WHERE fpl_entry_id = $1 AND email IS NULL AND openid IS NOT NULL AND openid != ''
         AND id <> $2
       LIMIT 1`,
			[fplEntryId, userId],
		);
		if (mpUser.rows[0]) {
			await client.query(`DELETE FROM bauth."user" WHERE id = $1`, [
				mpUser.rows[0].id,
			]);
			await client.query(
				`UPDATE bauth."user" SET openid = COALESCE(openid, $1), updated_at = NOW() WHERE id = $2`,
				[mpUser.rows[0].openid, userId],
			);
		}

		await client.query("COMMIT");
	} catch (err) {
		try {
			await client.query("ROLLBACK");
		} catch {
			/* ignore */
		}
		throw err;
	} finally {
		client.release();
	}
}
