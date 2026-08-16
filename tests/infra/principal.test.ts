import { createHmac } from "crypto";
import { describe, expect, test } from "bun:test";
import { env } from "../../src/infra/env";
import { getPrincipalFromHeaders, verifyWebsitePrincipal } from "../../src/infra/principal";

const addSignedHeader = (
	headers: Headers,
	name: "X-Ingress-Context" | "X-User-Context",
	envelope: Record<string, unknown>
): void => {
	const payload = JSON.stringify(envelope);
	headers.set(name, Buffer.from(payload).toString("base64url"));
	headers.set(
		`${name}-Sig`,
		createHmac("sha256", env.BACKEND_PROXY_SECRET).update(payload).digest("base64url")
	);
};

const canonicalIngress = (headers = new Headers()): Headers => {
	const now = Math.floor(Date.now() / 1000);
	addSignedHeader(headers, "X-Ingress-Context", {
		aud: "letletme-graphql",
		sub: "a".repeat(64),
		iat: now,
		exp: now + 60,
	});
	return headers;
};

const websiteHeaders = (envelope: Record<string, unknown>): Headers => {
	const headers = canonicalIngress();
	addSignedHeader(headers, "X-User-Context", envelope);
	return headers;
};

describe("website principal envelope", () => {
	test("does not expose an entry id without a verified-at timestamp", () => {
		const now = Math.floor(Date.now() / 1000);
		const principal = verifyWebsitePrincipal(
			websiteHeaders({
				aud: "letletme-graphql",
				uid: "user-1",
				eid: 123,
				evat: null,
				iat: now,
				exp: now + 60,
			})
		);

		expect(principal?.fplEntryId).toBeNull();
		expect(principal?.fplEntryVerifiedAt).toBeNull();
	});

	test("accepts only an exact canonical envelope with a verified positive entry id", () => {
		const now = Math.floor(Date.now() / 1000);
		const headers = websiteHeaders({
			aud: "letletme-graphql",
			uid: "user-1",
			eid: 123,
			evat: "2026-07-18T00:00:00.000Z",
			iat: now,
			exp: now + 60,
		});
		expect(verifyWebsitePrincipal(headers)?.fplEntryId).toBe(123);

		const payload = {
			aud: "letletme-graphql",
			uid: "user-1",
			eid: null,
			evat: null,
			iat: now,
			exp: now + 60,
			unexpectedField: true,
		};
		expect(verifyWebsitePrincipal(websiteHeaders(payload))).toBeNull();
	});

	test("preserves an explicit unverified season binding without granting proof", () => {
		const now = Math.floor(Date.now() / 1000);
		const principal = verifyWebsitePrincipal(
			websiteHeaders({
				v: 2,
				aud: "letletme-graphql",
				uid: "user-1",
				eid: 123,
				evat: null,
				bs: "2627",
				ba: "UNVERIFIED",
				bp: "DIRECT_BINDING",
				iat: now,
				exp: now + 60,
			})
		);

		expect(principal).toMatchObject({
			fplEntryId: 123,
			fplEntryVerifiedAt: null,
			fplEntrySeason: "2627",
			fplEntryBindingAssurance: "UNVERIFIED",
			envelopeVersion: 2,
		});
	});

	test("rejects envelopes whose expiry is not after issuance", () => {
		const now = Math.floor(Date.now() / 1000);
		expect(
			verifyWebsitePrincipal(
				websiteHeaders({
					aud: "letletme-graphql",
					uid: "user-1",
					eid: null,
					evat: null,
					iat: now,
					exp: now,
				})
			)
		).toBeNull();
	});
});

describe("Mini Program session authentication", () => {
	test("does not validate a bearer outside signed ingress", async () => {
		let validationCalls = 0;
		const principal = await getPrincipalFromHeaders(
			new Headers({ Authorization: "Bearer token" }),
			{
				validateMiniProgramSessionToken: async () => {
					validationCalls += 1;
					return null;
				},
			}
		);
		expect(principal).toBeNull();
		expect(validationCalls).toBe(0);
	});

	test("validates the canonical Mini Program session inside signed ingress", async () => {
		const expected = {
			userId: "mini-user",
			source: "wechat_miniprogram" as const,
			fplEntryId: 123,
			fplEntryVerifiedAt: "2026-07-18T00:00:00.000Z",
		};
		const headers = canonicalIngress(new Headers({ Authorization: "Bearer canonical-token" }));
		const principal = await getPrincipalFromHeaders(headers, {
			validateMiniProgramSessionToken: async (token) => {
				expect(token).toBe("canonical-token");
				return expected;
			},
		});
		expect(principal).toEqual(expected);
	});

	test("does not hide session lookup failures", async () => {
		const headers = canonicalIngress(new Headers({ Authorization: "Bearer token" }));
		await expect(
			getPrincipalFromHeaders(headers, {
				validateMiniProgramSessionToken: async () => {
					throw new Error("database unavailable");
				},
			})
		).rejects.toThrow("database unavailable");
	});

	test("rejects a request carrying both website and Bearer credentials", async () => {
		const now = Math.floor(Date.now() / 1000);
		const headers = websiteHeaders({
			v: 2,
			aud: "letletme-graphql",
			uid: "website-user",
			eid: null,
			evat: null,
			bs: null,
			ba: null,
			bp: null,
			iat: now,
			exp: now + 60,
		});
		headers.set("Authorization", "Bearer mini-token");
		expect(
			await getPrincipalFromHeaders(headers, {
				validateMiniProgramSessionToken: async () => ({
					userId: "mini-user",
					source: "wechat_miniprogram",
					fplEntryId: null,
					fplEntryVerifiedAt: null,
				}),
			})
		).toBeNull();
	});
});
