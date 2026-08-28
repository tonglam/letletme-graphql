import { createHash, createHmac, timingSafeEqual } from "crypto";
import { database } from "./database";
import { env } from "./env";
import { hasExactFields } from "./exact-fields";
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
	/** Entry selected for read-only viewer surfaces; it carries no ownership proof. */
	viewerEntryId?: number | null;
	fplEntryId: number | null;
	fplEntryVerifiedAt: string | null;
	/** Account-level role attested by the Website HMAC envelope. */
	platformAdmin?: boolean;
};

type WebsiteEnvelope = {
	aud?: unknown;
	uid?: unknown;
	eid?: unknown;
	evat?: unknown;
	adm?: unknown;
	iat?: unknown;
	exp?: unknown;
};

type MiniProgramSessionRow = {
	user_id: string | null;
	fpl_entry_id: number | null;
	fpl_entry_verified_at: Date | string | null;
	follow_entry_id: number | null;
	entry_choice: string | null;
	entry_choice_mini_entry_id: number | null;
	entry_choice_web_entry_id: number | null;
};

type PrincipalValidators = {
	validateMiniProgramSessionToken: (token: string) => Promise<Principal | null>;
};

export const hashMiniProgramSessionToken = (token: string): string =>
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
	const hasCanonicalFields = hasExactFields(envelope, [
		"aud",
		"uid",
		"eid",
		"evat",
		"adm",
		"iat",
		"exp",
	]);
	if (
		!hasCanonicalFields ||
		envelope.aud !== "letletme-graphql" ||
		typeof envelope.uid !== "string" ||
		envelope.uid.length === 0 ||
		typeof envelope.adm !== "boolean" ||
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
		Boolean(verifiedAt)
			? envelope.eid
			: null;

	return {
		userId: envelope.uid,
		source: "website",
		viewerEntryId: fplEntryId,
		fplEntryId,
		fplEntryVerifiedAt: fplEntryId === null || !verifiedAt ? null : verifiedAt,
		platformAdmin: fplEntryId !== null && envelope.adm === true,
	};
};

export const resolveMiniProgramViewerEntry = (
	row: Pick<
		MiniProgramSessionRow,
		| "fpl_entry_id"
		| "follow_entry_id"
		| "entry_choice"
		| "entry_choice_mini_entry_id"
		| "entry_choice_web_entry_id"
	>
): number | null => {
	const miniEntryId = row.follow_entry_id;
	const webEntryId = row.fpl_entry_id;
	if (!miniEntryId) return webEntryId;
	if (!webEntryId || miniEntryId === webEntryId) return miniEntryId;
	const resolvedToWeb =
		row.entry_choice === "WEB" &&
		row.entry_choice_mini_entry_id === miniEntryId &&
		row.entry_choice_web_entry_id === webEntryId;
	return resolvedToWeb ? webEntryId : miniEntryId;
};

const getBearerToken = (headers: Headers): string | null => {
	const header = headers.get("Authorization");
	const match = header?.match(/^bearer\s+(.+)$/i);
	return match?.[1]?.trim() || null;
};

export const validateMiniProgramSessionToken = async (token: string): Promise<Principal | null> => {
	const tokenHash = hashMiniProgramSessionToken(token);
	const result = await database.query<MiniProgramSessionRow>(
		`SELECT COALESCE(account.id, s.user_id) AS user_id,
		        CASE
		          WHEN account.id IS NOT NULL AND linked_user.fpl_entry_verified_at IS NOT NULL
		            THEN linked_user.fpl_entry_id
		          WHEN account.id IS NULL AND legacy_user.fpl_entry_verified_at IS NOT NULL
		            THEN legacy_user.fpl_entry_id
		        END AS fpl_entry_id,
		        CASE
		          WHEN account.id IS NOT NULL THEN linked_user.fpl_entry_verified_at
		          ELSE legacy_user.fpl_entry_verified_at
		        END AS fpl_entry_verified_at,
		        account.follow_entry_id,
		        account.entry_choice,
		        account.entry_choice_mini_entry_id,
		        account.entry_choice_web_entry_id
		 FROM bauth.mini_program_session s
		 LEFT JOIN bauth.mini_program_account account ON account.id = s.account_id
		 LEFT JOIN bauth."user" linked_user ON linked_user.id = account.linked_web_user_id
		 LEFT JOIN bauth."user" legacy_user ON legacy_user.id = s.user_id
		 WHERE s.token_hash = $1
		   AND s.revoked_at IS NULL
		   AND s.expires_at > NOW()
		 LIMIT 1`,
		[tokenHash]
	);
	const row = result.rows[0];
	if (!row || !row.user_id) return null;
	metrics.authTokenValidations.labels("web_mini_program").inc();

	return {
		userId: row.user_id,
		source: "wechat_miniprogram",
		viewerEntryId: resolveMiniProgramViewerEntry(row),
		fplEntryId: row.fpl_entry_id,
		fplEntryVerifiedAt: row.fpl_entry_verified_at
			? new Date(row.fpl_entry_verified_at).toISOString()
			: null,
		platformAdmin: false,
	};
};

export const getPrincipalFromHeaders = async (
	headers: Headers,
	validators: PrincipalValidators = {
		validateMiniProgramSessionToken,
	}
): Promise<Principal | null> => {
	if (!verifyIngressContext(headers)) return null;
	const token = getBearerToken(headers);
	const websitePrincipal = verifyWebsitePrincipal(headers);
	if (websitePrincipal) {
		// A request carrying both credential families is ambiguous. Reject it
		// instead of relying on parser order to choose an identity.
		return token ? null : websitePrincipal;
	}
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
