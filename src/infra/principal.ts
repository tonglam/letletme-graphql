import { createHash, createHmac, timingSafeEqual } from "crypto";
import { database } from "./database";
import { env } from "./env";
import { verifyIngressContext } from "./ingress-context";
import { metrics } from "./metrics";

export interface AuthUser {
	id: string;
	email: string | null;
	name: string | null;
	emailVerified: boolean;
	image?: string | null;
	fplEntryId?: number | null;
	fplEntryVerifiedAt?: string | null;
}

export type PrincipalSource = "website" | "wechat_miniprogram";

export type Principal = {
	userId: string;
	source: PrincipalSource;
	provider: "better_auth" | "wechat_miniprogram";
	fplEntryId: number | null;
	fplEntryVerifiedAt: string | null;
};

type WebsiteEnvelope = {
	aud?: unknown;
	uid?: unknown;
	eid?: unknown;
	evat?: unknown;
	iat?: unknown;
	exp?: unknown;
};

type MiniProgramSessionRow = {
	user_id: string;
	fpl_entry_id: number | null;
	fpl_entry_verified_at: Date | string | null;
};

type PrincipalValidators = {
	validateMiniProgramSessionToken: (token: string) => Promise<Principal | null>;
};

const WECHAT_PROVIDER = "wechat_miniprogram";

export const hashMiniProgramSessionToken = (token: string): string =>
	createHash("sha256").update(token).digest("hex");

const equalBase64Url = (left: string, right: string): boolean => {
	if (!/^[A-Za-z0-9_-]+$/.test(left) || !/^[A-Za-z0-9_-]+$/.test(right)) return false;
	const leftBytes = Buffer.from(left);
	const rightBytes = Buffer.from(right);
	return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
};

const hasExactFields = (value: object, fields: readonly string[]): boolean => {
	const actual = Object.keys(value).sort();
	const expected = [...fields].sort();
	return (
		actual.length === expected.length && actual.every((field, index) => field === expected[index])
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
	const issuedAt =
		typeof envelope.iat === "number" && Number.isSafeInteger(envelope.iat) ? envelope.iat : null;
	const expiresAt =
		typeof envelope.exp === "number" && Number.isSafeInteger(envelope.exp) ? envelope.exp : null;
	if (
		!hasExactFields(envelope, ["aud", "uid", "eid", "evat", "iat", "exp"]) ||
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

export const validateMiniProgramSessionToken = async (token: string): Promise<Principal | null> => {
	const tokenHash = hashMiniProgramSessionToken(token);
	const result = await database.query<MiniProgramSessionRow>(
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
	}
): Promise<Principal | null> => {
	if (!verifyIngressContext(headers)) return null;
	const websitePrincipal = verifyWebsitePrincipal(headers);
	if (websitePrincipal) return websitePrincipal;

	const token = getBearerToken(headers);
	if (!token) return null;

	return validators.validateMiniProgramSessionToken(token);
};

export const principalToAuthUser = (principal: Principal): AuthUser => ({
	id: principal.userId,
	email: null,
	name: null,
	emailVerified: false,
	fplEntryId: principal.fplEntryId,
	fplEntryVerifiedAt: principal.fplEntryVerifiedAt,
});
