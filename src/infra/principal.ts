import {
	createHash,
	createHmac,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from "crypto";
import type { AuthUser } from "./auth";
import { dbPool } from "./db-pool";
import { env } from "./env";
import { logger } from "./logger";

export type PrincipalSource = "website" | "wechat_miniprogram" | "device";

export type Principal = {
	userId: string;
	source: PrincipalSource;
	provider: "better_auth" | "wechat_miniprogram" | "device";
	fplEntryId: number | null;
};

export type ApiSession = {
	token: string;
	expiresAt: string;
	user: {
		id: string;
		fplEntryId: number | null;
	};
};

type WebsiteEnvelope = {
	uid?: unknown;
	eid?: unknown;
	iat?: unknown;
	exp?: unknown;
};

type WechatResponse = {
	openid?: string;
	session_key?: string;
	errcode?: number;
	errmsg?: string;
};

type ApiSessionRow = {
	user_id: string;
	fpl_entry_id: number | null;
};

type IdentityRow = {
	user_id: string;
};

type UserIdentityRow = {
	id: string;
};

const WECHAT_PROVIDER = "wechat_miniprogram";

export const hashApiToken = (token: string): string =>
	createHash("sha256").update(token).digest("hex");

const equalBase64Url = (left: string, right: string): boolean => {
	const leftBytes = Buffer.from(left);
	const rightBytes = Buffer.from(right);
	return (
		leftBytes.length === rightBytes.length &&
		timingSafeEqual(leftBytes, rightBytes)
	);
};

export const verifyWebsitePrincipal = (headers: Headers): Principal | null => {
	if (!env.BACKEND_PROXY_SECRET) return null;

	const contextHeader = headers.get("X-User-Context");
	const sigHeader = headers.get("X-User-Context-Sig");
	if (!contextHeader || !sigHeader) return null;

	let payload: string;
	let envelope: WebsiteEnvelope;
	try {
		payload = Buffer.from(contextHeader, "base64url").toString("utf8");
		envelope = JSON.parse(payload) as WebsiteEnvelope;
	} catch {
		return null;
	}

	const expectedSig = createHmac("sha256", env.BACKEND_PROXY_SECRET)
		.update(payload)
		.digest("base64url");
	if (!equalBase64Url(sigHeader, expectedSig)) return null;

	const now = Math.floor(Date.now() / 1000);
	if (
		typeof envelope.uid !== "string" ||
		typeof envelope.iat !== "number" ||
		typeof envelope.exp !== "number" ||
		envelope.iat > now + 30 ||
		envelope.exp < now
	) {
		return null;
	}

	const fplEntryId =
		typeof envelope.eid === "number" && Number.isInteger(envelope.eid)
			? envelope.eid
			: null;

	return {
		userId: envelope.uid,
		source: "website",
		provider: "better_auth",
		fplEntryId,
	};
};

const getBearerToken = (headers: Headers): string | null => {
	const header = headers.get("Authorization");
	const match = header?.match(/^bearer\s+(.+)$/i);
	return match?.[1]?.trim() || null;
};

export const validateApiSessionToken = async (
	token: string,
): Promise<Principal | null> => {
	const tokenHash = hashApiToken(token);
	const result = await dbPool.query<ApiSessionRow>(
		`SELECT s.user_id, u.fpl_entry_id
       FROM bauth.api_sessions s
       JOIN bauth."user" u ON u.id = s.user_id
       WHERE s.token_hash = $1
         AND s.provider = $2
         AND s.revoked_at IS NULL
         AND s.expires_at > NOW()
       LIMIT 1`,
		[tokenHash, WECHAT_PROVIDER],
	);

	const row = result.rows[0];
	if (!row) return null;

	void dbPool
		.query(
			`UPDATE bauth.api_sessions
         SET last_active_at = NOW()
         WHERE token_hash = $1`,
			[tokenHash],
		)
		.catch((err: unknown) => {
			logger.warn({ err }, "Failed to update api session last_active_at");
		});

	return {
		userId: row.user_id,
		source: "wechat_miniprogram",
		provider: WECHAT_PROVIDER,
		fplEntryId: row.fpl_entry_id,
	};
};

export const getPrincipalFromHeaders = async (
	headers: Headers,
): Promise<Principal | null> => {
	const websitePrincipal = verifyWebsitePrincipal(headers);
	if (websitePrincipal) return websitePrincipal;

	const token = getBearerToken(headers);
	if (!token) return null;

	return validateApiSessionToken(token);
};

export const principalToAuthUser = (principal: Principal): AuthUser => ({
	id: principal.userId,
	email: null,
	name: null,
	emailVerified: false,
	isAnonymous: principal.source !== "website",
	fplEntryId: principal.fplEntryId,
});

const exchangeWechatCode = async (code: string): Promise<string> => {
	if (!env.WECHAT_APPID || !env.WECHAT_APPSECRET) {
		throw new Error("WeChat Mini Program credentials are not configured");
	}

	const url =
		`https://api.weixin.qq.com/sns/jscode2session` +
		`?appid=${encodeURIComponent(env.WECHAT_APPID)}` +
		`&secret=${encodeURIComponent(env.WECHAT_APPSECRET)}` +
		`&js_code=${encodeURIComponent(code)}` +
		`&grant_type=authorization_code`;
	const response = await fetch(url);
	const data = (await response.json()) as WechatResponse;
	if (!data.openid) {
		throw new Error(`WeChat auth failed: ${data.errmsg ?? "unknown"}`);
	}
	return data.openid;
};

const normalizeFplEntryId = (value?: number | null): number | null =>
	typeof value === "number" && Number.isInteger(value) && value > 0
		? value
		: null;

export const createWechatApiSession = async (
	code: string,
	fplEntryId?: number | null,
): Promise<ApiSession> => {
	const openid = await exchangeWechatCode(code);
	const effectiveEntryId = normalizeFplEntryId(fplEntryId);
	const client = await dbPool.connect();

	try {
		await client.query("BEGIN");

		const existingIdentity = await client.query<IdentityRow>(
			`SELECT user_id
       FROM bauth.external_identities
       WHERE provider = $1 AND provider_subject = $2
       LIMIT 1`,
			[WECHAT_PROVIDER, openid],
		);

		let userId = existingIdentity.rows[0]?.user_id;
		if (!userId) {
			const existingUser = await client.query<UserIdentityRow>(
				`SELECT id
         FROM bauth."user"
         WHERE openid = $1
         ORDER BY email IS NULL ASC, created_at ASC
         LIMIT 1`,
				[openid],
			);

			userId = existingUser.rows[0]?.id;
		}

		if (!userId) {
			// Do not accept attacker-supplied fplEntryId on first create without
			// ownership proof — bind entry later via authenticated bindFplEntry.
			userId = randomUUID();
			await client.query(
				`INSERT INTO bauth."user"
         (id, openid, fpl_entry_id, email_verified, created_at, updated_at)
         VALUES ($1, $2, NULL, false, NOW(), NOW())`,
				[userId, openid],
			);
		} else if (effectiveEntryId !== null) {
			const conflict = await client.query<{ id: string }>(
				`SELECT id FROM bauth."user"
         WHERE fpl_entry_id = $1 AND id <> $2
         LIMIT 1`,
				[effectiveEntryId, userId],
			);
			if (conflict.rows[0]) {
				throw new Error(
					"FPL entry is already bound to another account",
				);
			}
			await client.query(
				`UPDATE bauth."user"
         SET openid = COALESCE(NULLIF(openid, ''), $1),
             fpl_entry_id = COALESCE(fpl_entry_id, $2),
             updated_at = NOW()
         WHERE id = $3`,
				[openid, effectiveEntryId, userId],
			);
		} else {
			await client.query(
				`UPDATE bauth."user"
         SET openid = COALESCE(NULLIF(openid, ''), $1),
             updated_at = NOW()
         WHERE id = $2`,
				[openid, userId],
			);
		}

		if (!existingIdentity.rows[0]) {
			await client.query(
				`INSERT INTO bauth.external_identities
         (id, user_id, provider, provider_subject, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         ON CONFLICT (provider, provider_subject) DO NOTHING`,
				[randomUUID(), userId, WECHAT_PROVIDER, openid],
			);
		}

		const token = `llm_wx_${randomBytes(32).toString("base64url")}`;
		const tokenHash = hashApiToken(token);
		const expiresAt = new Date(
			Date.now() + env.WECHAT_API_SESSION_TTL_SECONDS * 1000,
		);

		await client.query(
			`INSERT INTO bauth.api_sessions
       (id, user_id, client_type, provider, token_hash, expires_at, created_at, last_active_at)
       VALUES ($1, $2, 'wechat_miniprogram', $3, $4, $5, NOW(), NOW())`,
			[randomUUID(), userId, WECHAT_PROVIDER, tokenHash, expiresAt],
		);

		const userResult = await client.query<{ fpl_entry_id: number | null }>(
			`SELECT fpl_entry_id FROM bauth."user" WHERE id = $1`,
			[userId],
		);
		const boundEntryId = userResult.rows[0]?.fpl_entry_id ?? null;

		await client.query("COMMIT");

		return {
			token,
			expiresAt: expiresAt.toISOString(),
			user: {
				id: userId,
				fplEntryId: boundEntryId,
			},
		};
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
};
