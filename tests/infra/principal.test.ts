import { createHmac } from "crypto";
import { describe, expect, test } from "bun:test";
import { env } from "../../src/infra/env";
import {
	getPrincipalFromHeaders,
	resolveMiniProgramViewerEntry,
	verifyWebsitePrincipal,
} from "../../src/infra/principal";

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
		v: 2,
		aud: "letletme-graphql",
		trafficClass: "web_browser",
		subject: "a".repeat(64),
		abuseSubject: null,
		workload: "public-other",
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
				adm: false,
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
			adm: false,
			iat: now,
			exp: now + 60,
		});
		expect(verifyWebsitePrincipal(headers)?.fplEntryId).toBe(123);
		expect(verifyWebsitePrincipal(headers)?.viewerEntryId).toBe(123);

		const payload = {
			aud: "letletme-graphql",
			uid: "user-1",
			eid: null,
			evat: null,
			adm: false,
			iat: now,
			exp: now + 60,
			unexpectedField: true,
		};
		expect(verifyWebsitePrincipal(websiteHeaders(payload))).toBeNull();
	});

	test("rejects the pre-role envelope instead of treating a missing role as false", () => {
		const now = Math.floor(Date.now() / 1000);
		expect(
			verifyWebsitePrincipal(
				websiteHeaders({
					aud: "letletme-graphql",
					uid: "user-1",
					eid: null,
					evat: null,
					iat: now,
					exp: now + 60,
				})
			)
		).toBeNull();
	});

	test("accepts a signed platform role and keeps ordinary users non-admin", () => {
		const now = Math.floor(Date.now() / 1000);
		const ordinaryUser = verifyWebsitePrincipal(
			websiteHeaders({
				aud: "letletme-graphql",
				uid: "ordinary-user",
				eid: 6953,
				evat: "2026-08-21T00:00:00.000Z",
				adm: false,
				iat: now,
				exp: now + 60,
			})
		);
		expect(ordinaryUser?.platformAdmin).toBe(false);

		const platformAdmin = verifyWebsitePrincipal(
			websiteHeaders({
				aud: "letletme-graphql",
				uid: "platform-admin",
				eid: 6953,
				evat: "2026-08-21T00:00:00.000Z",
				adm: true,
				iat: now,
				exp: now + 60,
			})
		);
		expect(platformAdmin?.platformAdmin).toBe(true);
	});

	test("rejects a non-boolean platform role", () => {
		const now = Math.floor(Date.now() / 1000);
		expect(
			verifyWebsitePrincipal(
				websiteHeaders({
					aud: "letletme-graphql",
					uid: "user-1",
					eid: 6953,
					evat: "2026-08-21T00:00:00.000Z",
					adm: "true",
					iat: now,
					exp: now + 60,
				})
			)
		).toBeNull();
	});

	test("rejects a signed user envelope with an unsupported shape", () => {
		const now = Math.floor(Date.now() / 1000);
		expect(
			verifyWebsitePrincipal(
				websiteHeaders({
					v: 2,
					aud: "letletme-graphql",
					uid: "user-1",
					eid: null,
					evat: null,
					adm: false,
					bs: null,
					ba: null,
					bp: null,
					iat: now,
					exp: now + 60,
				})
			)
		).toBeNull();
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
					adm: false,
					iat: now,
					exp: now,
				})
			)
		).toBeNull();
	});
});

describe("Mini Program session authentication", () => {
	test("resolves the effective viewer without treating it as verified ownership", () => {
		expect(
			resolveMiniProgramViewerEntry({
				fpl_entry_id: null,
				follow_entry_id: 6953,
				entry_choice: null,
				entry_choice_mini_entry_id: null,
				entry_choice_web_entry_id: null,
			})
		).toBe(6953);
		expect(
			resolveMiniProgramViewerEntry({
				fpl_entry_id: 123,
				follow_entry_id: 6953,
				entry_choice: "WEB",
				entry_choice_mini_entry_id: 6953,
				entry_choice_web_entry_id: 123,
			})
		).toBe(123);
		expect(
			resolveMiniProgramViewerEntry({
				fpl_entry_id: 456,
				follow_entry_id: 6953,
				entry_choice: "WEB",
				entry_choice_mini_entry_id: 6953,
				entry_choice_web_entry_id: 123,
			})
		).toBe(6953);
	});

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
			aud: "letletme-graphql",
			uid: "website-user",
			eid: null,
			evat: null,
			adm: false,
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
