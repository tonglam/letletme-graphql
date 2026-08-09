import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { dbPool } from "./db-pool";
import { env } from "./env";
import { logger } from "./logger";
import { metrics } from "./metrics";
import { getRedis } from "./redis";

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
	fplEntryVerifiedAt?: string | null;
}

export type PrincipalSource = "website" | "wechat_miniprogram" | "device";

export type Principal = {
	userId: string;
	source: PrincipalSource;
	provider: "better_auth" | "wechat_miniprogram" | "device";
	fplEntryId: number | null;
	fplEntryVerifiedAt: string | null;
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
	v?: unknown;
	aud?: unknown;
	uid?: unknown;
	eid?: unknown;
	evat?: unknown;
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
	fpl_entry_verified_at: Date | string | null;
};

type MiniProgramSessionRow = ApiSessionRow;

type IdentityRow = {
	user_id: string;
};

type UserIdentityRow = {
	id: string;
};

type PrincipalValidators = {
	validateMiniProgramSessionToken: (token: string) => Promise<Principal | null>;
	validateApiSessionToken: (token: string) => Promise<Principal | null>;
};

const WECHAT_PROVIDER = "wechat_miniprogram";

export const isUndefinedTableError = (error: unknown): boolean => {
	if (!error || typeof error !== "object") return false;
	return "code" in error && (error as { code?: unknown }).code === "42P01";
};

export const isLegacyAuthValidationOpen = (
	now = Date.now(),
	deadline = env.LEGACY_AUTH_VALIDATION_UNTIL
): boolean => typeof deadline === "number" && now <= deadline;

export const hashApiToken = (token: string): string =>
	createHash("sha256").update(token).digest("hex");

const equalBase64Url = (left: string, right: string): boolean => {
	if (!/^[A-Za-z0-9_-]+$/.test(left) || !/^[A-Za-z0-9_-]+$/.test(right)) return false;
	const leftBytes = Buffer.from(left);
	const rightBytes = Buffer.from(right);
	return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
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
	const issuedAt =
		typeof envelope.iat === "number" && Number.isSafeInteger(envelope.iat) ? envelope.iat : null;
	const expiresAt =
		typeof envelope.exp === "number" && Number.isSafeInteger(envelope.exp) ? envelope.exp : null;
	if (
		envelope.v !== 2 ||
		envelope.aud !== "letletme-graphql" ||
		typeof envelope.uid !== "string" ||
		envelope.uid.length === 0 ||
		issuedAt === null ||
		expiresAt === null ||
		issuedAt > now + 30 ||
		expiresAt <= issuedAt ||
		expiresAt < now ||
		expiresAt - issuedAt > 60
	) {
		return null;
	}

	const verifiedAtCandidate = typeof envelope.evat === "string" ? envelope.evat.trim() : "";
	const verifiedAt =
		verifiedAtCandidate.length > 0 && Number.isFinite(Date.parse(verifiedAtCandidate))
			? verifiedAtCandidate
			: null;
	const fplEntryId =
		typeof envelope.eid === "number" &&
		Number.isSafeInteger(envelope.eid) &&
		envelope.eid > 0 &&
		verifiedAt
			? envelope.eid
			: null;

	return {
		userId: envelope.uid,
		source: "website",
		provider: "better_auth",
		fplEntryId,
		fplEntryVerifiedAt: fplEntryId === null ? null : verifiedAt,
	};
};

const getBearerToken = (headers: Headers): string | null => {
	const header = headers.get("Authorization");
	const match = header?.match(/^bearer\s+(.+)$/i);
	return match?.[1]?.trim() || null;
};

export const validateApiSessionToken = async (token: string): Promise<Principal | null> => {
	if (!isLegacyAuthValidationOpen()) return null;
	const tokenHash = hashApiToken(token);
	const result = await dbPool.query<ApiSessionRow>(
		`SELECT s.user_id,
		        CASE WHEN u.fpl_entry_verified_at IS NOT NULL THEN u.fpl_entry_id END AS fpl_entry_id,
		        u.fpl_entry_verified_at
       FROM bauth.api_sessions s
       JOIN bauth."user" u ON u.id = s.user_id
       WHERE s.token_hash = $1
         AND s.provider = $2
         AND s.revoked_at IS NULL
         AND s.expires_at > NOW()
       LIMIT 1`,
		[tokenHash, WECHAT_PROVIDER]
	);

	const row = result.rows[0];
	if (!row) return null;
	metrics.authTokenValidations.labels("legacy_graphql_wechat").inc();

	void dbPool
		.query(
			`UPDATE bauth.api_sessions
         SET last_active_at = NOW()
         WHERE token_hash = $1`,
			[tokenHash]
		)
		.catch((err: unknown) => {
			logger.warn({ err }, "Failed to update api session last_active_at");
		});

	return {
		userId: row.user_id,
		source: "wechat_miniprogram",
		provider: WECHAT_PROVIDER,
		fplEntryId: row.fpl_entry_id,
		fplEntryVerifiedAt: row.fpl_entry_verified_at
			? new Date(row.fpl_entry_verified_at).toISOString()
			: null,
	};
};

export const validateMiniProgramSessionToken = async (token: string): Promise<Principal | null> => {
	const tokenHash = hashApiToken(token);
	const result = await dbPool.query<MiniProgramSessionRow>(
		`SELECT s.user_id,
		        CASE WHEN u.fpl_entry_verified_at IS NOT NULL THEN u.fpl_entry_id END AS fpl_entry_id,
		        u.fpl_entry_verified_at
		 FROM bauth.mini_program_session s
		 JOIN bauth."user" u ON u.id = s.user_id
		 WHERE s.token_hash = $1
		   AND s.revoked_at IS NULL
		   AND s.expires_at > NOW()
		 LIMIT 1`,
		[tokenHash]
	);
	const row = result.rows[0];
	if (!row) return null;
	metrics.authTokenValidations.labels("web_mini_program").inc();

	return {
		userId: row.user_id,
		source: "wechat_miniprogram",
		provider: WECHAT_PROVIDER,
		fplEntryId: row.fpl_entry_id,
		fplEntryVerifiedAt: row.fpl_entry_verified_at
			? new Date(row.fpl_entry_verified_at).toISOString()
			: null,
	};
};

export const getPrincipalFromHeaders = async (
	headers: Headers,
	validators: PrincipalValidators = {
		validateMiniProgramSessionToken,
		validateApiSessionToken,
	}
): Promise<Principal | null> => {
	const websitePrincipal = verifyWebsitePrincipal(headers);
	if (websitePrincipal) return websitePrincipal;

	const token = getBearerToken(headers);
	if (!token) return null;

	let miniProgramPrincipal: Principal | null = null;
	try {
		miniProgramPrincipal = await validators.validateMiniProgramSessionToken(token);
	} catch (error) {
		if (!isUndefinedTableError(error)) throw error;
		// GraphQL is intentionally deployable before the Web migration that owns
		// this table. During that bounded compatibility window, treat absence as a
		// miss and continue to the deadline-gated legacy validator.
		logger.warn(
			{ err: error },
			"Mini Program session table is not migrated; using legacy validation"
		);
	}
	return miniProgramPrincipal ?? validators.validateApiSessionToken(token);
};

export const principalToAuthUser = (principal: Principal): AuthUser => ({
	id: principal.userId,
	email: null,
	name: null,
	emailVerified: false,
	isAnonymous: principal.source !== "website",
	fplEntryId: principal.fplEntryId,
	fplEntryVerifiedAt: principal.fplEntryVerifiedAt,
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

export const createWechatApiSession = async (
	code: string,
	_fplEntryId?: number | null
): Promise<ApiSession> => {
	if (!env.LEGACY_WECHAT_ISSUANCE_ENABLED) {
		throw new Error(
			"Legacy WeChat session issuance is disabled; authenticate through letletme-web"
		);
	}
	const codeHash = hashApiToken(code);
	const claimed = await getRedis().set(
		`gql:v2:security:wechat-code:${codeHash}`,
		"1",
		"EX",
		10 * 60,
		"NX"
	);
	if (claimed !== "OK") {
		throw new Error("WeChat login code has already been used");
	}
	const openid = await exchangeWechatCode(code);
	const client = await dbPool.connect();

	try {
		await client.query("BEGIN");

		const existingIdentity = await client.query<IdentityRow>(
			`SELECT user_id
       FROM bauth.external_identities
       WHERE provider = $1 AND provider_subject = $2
       LIMIT 1`,
			[WECHAT_PROVIDER, openid]
		);

		let userId = existingIdentity.rows[0]?.user_id;
		let provisionalUserId: string | null = null;
		if (!userId) {
			const existingUser = await client.query<UserIdentityRow>(
				`SELECT id
         FROM bauth."user"
         WHERE openid = $1
         ORDER BY email IS NULL ASC, created_at ASC
         LIMIT 1`,
				[openid]
			);

			userId = existingUser.rows[0]?.id;
		}

		if (!userId) {
			// Entry binding is exclusively owned by letletme-web and is never
			// accepted from this legacy exchange.
			userId = randomUUID();
			provisionalUserId = userId;
			await client.query(
				`INSERT INTO bauth."user"
         (id, openid, fpl_entry_id, email_verified, created_at, updated_at)
         VALUES ($1, $2, NULL, false, NOW(), NOW())`,
				[userId, openid]
			);
		} else {
			await client.query(
				`UPDATE bauth."user"
         SET openid = COALESCE(NULLIF(openid, ''), $1),
             updated_at = NOW()
         WHERE id = $2`,
				[openid, userId]
			);
		}

		if (!existingIdentity.rows[0]) {
			const identityInsert = await client.query(
				`INSERT INTO bauth.external_identities
         (id, user_id, provider, provider_subject, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         ON CONFLICT (provider, provider_subject) DO NOTHING`,
				[randomUUID(), userId, WECHAT_PROVIDER, openid]
			);
			if (identityInsert.rowCount === 0) {
				const owner = await client.query<IdentityRow>(
					`SELECT user_id
					 FROM bauth.external_identities
					 WHERE provider = $1 AND provider_subject = $2
					 LIMIT 1`,
					[WECHAT_PROVIDER, openid]
				);
				const canonicalUserId = owner.rows[0]?.user_id;
				if (!canonicalUserId) {
					throw new Error("External identity conflict did not expose its owner");
				}
				if (provisionalUserId && provisionalUserId !== canonicalUserId) {
					await client.query(
						`DELETE FROM bauth."user"
						 WHERE id = $1 AND openid = $2
						   AND NOT EXISTS (
							 SELECT 1 FROM bauth.external_identities WHERE user_id = $1
						   )
						   AND NOT EXISTS (
							 SELECT 1 FROM bauth.api_sessions WHERE user_id = $1
						   )`,
						[provisionalUserId, openid]
					);
				}
				userId = canonicalUserId;
			}
		}

		const token = `llm_wx_${randomBytes(32).toString("base64url")}`;
		const tokenHash = hashApiToken(token);
		const expiresAt = new Date(Date.now() + env.WECHAT_API_SESSION_TTL_SECONDS * 1000);

		await client.query(
			`INSERT INTO bauth.api_sessions
       (id, user_id, client_type, provider, token_hash, expires_at, created_at, last_active_at)
       VALUES ($1, $2, 'wechat_miniprogram', $3, $4, $5, NOW(), NOW())`,
			[randomUUID(), userId, WECHAT_PROVIDER, tokenHash, expiresAt]
		);

		const userResult = await client.query<{ fpl_entry_id: number | null }>(
			`SELECT CASE WHEN fpl_entry_verified_at IS NOT NULL THEN fpl_entry_id END AS fpl_entry_id
			 FROM bauth."user" WHERE id = $1`,
			[userId]
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
