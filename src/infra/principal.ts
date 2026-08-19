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
	fplEntrySeason?: string | null;
	fplEntryBindingAssurance?: string | null;
	fplEntryBindingProofKind?: string | null;
}

export type PrincipalSource = "website" | "wechat_miniprogram";

export type Principal = {
	userId: string;
	source: PrincipalSource;
	fplEntryId: number | null;
	fplEntryVerifiedAt: string | null;
	fplEntrySeason?: string | null;
	fplEntryBindingAssurance?: string | null;
	fplEntryBindingProofKind?: string | null;
	envelopeVersion?: 1 | 2;
};

type WebsiteEnvelope = {
	v?: unknown;
	aud?: unknown;
	uid?: unknown;
	eid?: unknown;
	evat?: unknown;
	iat?: unknown;
	exp?: unknown;
	bs?: unknown;
	ba?: unknown;
	bp?: unknown;
};

type MiniProgramSessionRow = {
	user_id: string;
	fpl_entry_id: number | null;
	fpl_entry_verified_at: Date | string | null;
	fpl_entry_season: string | null;
	fpl_entry_binding_assurance: string | null;
	fpl_entry_binding_proof_kind: string | null;
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
	const version = envelope.v === 2 ? 2 : 1;
	const expectedFields =
		version === 2
			? ["v", "aud", "uid", "eid", "evat", "bs", "ba", "bp", "iat", "exp"]
			: ["aud", "uid", "eid", "evat", "iat", "exp"];
	if (
		!hasExactFields(envelope, expectedFields) ||
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

	const bindingSeason =
		version === 2 && typeof envelope.bs === "string" && /^\d{4}$/.test(envelope.bs)
			? envelope.bs
			: null;
	const assurance = version === 2 && typeof envelope.ba === "string" ? envelope.ba : null;
	const proofKind = version === 2 && typeof envelope.bp === "string" ? envelope.bp : null;
	if (version === 2) {
		const validAssurance =
			assurance === null || assurance === "UNVERIFIED" || assurance === "OWNERSHIP_VERIFIED";
		const validProof =
			proofKind === null ||
			["DIRECT_BINDING", "TEAM_NAME_CHALLENGE", "OPERATOR_VERIFIED"].includes(proofKind);
		const entryIdPresent =
			typeof envelope.eid === "number" && Number.isSafeInteger(envelope.eid) && envelope.eid > 0;
		const bindingShapeValid =
			(!entryIdPresent && bindingSeason === null && assurance === null && proofKind === null) ||
			(entryIdPresent &&
				bindingSeason !== null &&
				assurance !== null &&
				proofKind !== null &&
				((assurance === "UNVERIFIED" && envelope.evat === null) ||
					(assurance === "OWNERSHIP_VERIFIED" && typeof envelope.evat === "string")));
		if (!validAssurance || !validProof || !bindingShapeValid) return null;
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
		(version === 2 || Boolean(verifiedAt))
			? envelope.eid
			: null;

	return {
		userId: envelope.uid,
		source: "website",
		fplEntryId,
		fplEntryVerifiedAt: fplEntryId === null || !verifiedAt ? null : verifiedAt,
		fplEntrySeason: bindingSeason,
		fplEntryBindingAssurance: assurance,
		fplEntryBindingProofKind: proofKind,
		envelopeVersion: version,
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
		        u.fpl_entry_id,
		        u.fpl_entry_verified_at,
		        u.fpl_entry_season,
		        u.fpl_entry_binding_assurance,
		        u.fpl_entry_binding_proof_kind
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
		fplEntryId: row.fpl_entry_id,
		fplEntryVerifiedAt: row.fpl_entry_verified_at
			? new Date(row.fpl_entry_verified_at).toISOString()
			: null,
		fplEntrySeason: row.fpl_entry_season,
		fplEntryBindingAssurance: row.fpl_entry_binding_assurance ?? undefined,
		fplEntryBindingProofKind: row.fpl_entry_binding_proof_kind ?? undefined,
		envelopeVersion: 2,
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
	fplEntrySeason: principal.fplEntrySeason,
	fplEntryBindingAssurance: principal.fplEntryBindingAssurance,
	fplEntryBindingProofKind: principal.fplEntryBindingProofKind,
});
