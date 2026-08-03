import { createHmac } from "crypto";
import { describe, expect, test } from "bun:test";
import { env } from "../../src/infra/env";
import {
	getPrincipalFromHeaders,
	isLegacyAuthValidationOpen,
	verifyWebsitePrincipal,
} from "../../src/infra/principal";

describe("legacy authentication grace window", () => {
	test("is closed when no explicit deadline is configured", () => {
		expect(isLegacyAuthValidationOpen(1_000, null)).toBe(false);
	});

	test("accepts validation through the deadline and rejects it afterward", () => {
		expect(isLegacyAuthValidationOpen(1_000, 1_000)).toBe(true);
		expect(isLegacyAuthValidationOpen(1_001, 1_000)).toBe(false);
	});
});

describe("website principal envelope", () => {
	const signedHeaders = (envelope: Record<string, unknown>): Headers => {
		const payload = JSON.stringify(envelope);
		const signature = createHmac("sha256", env.BACKEND_PROXY_SECRET)
			.update(payload)
			.digest("base64url");
		return new Headers({
			"X-User-Context": Buffer.from(payload).toString("base64url"),
			"X-User-Context-Sig": signature,
		});
	};

	test("does not expose an entry id without a verified-at timestamp", () => {
		const now = Math.floor(Date.now() / 1000);
		const principal = verifyWebsitePrincipal(
			signedHeaders({
				v: 2,
				aud: "letletme-graphql",
				uid: "user-1",
				eid: 123,
				iat: now,
				exp: now + 60,
			})
		);

		expect(principal?.fplEntryId).toBeNull();
		expect(principal?.fplEntryVerifiedAt).toBeNull();
	});

	test("accepts only a verified positive entry id", () => {
		const now = Math.floor(Date.now() / 1000);
		const principal = verifyWebsitePrincipal(
			signedHeaders({
				v: 2,
				aud: "letletme-graphql",
				uid: "user-1",
				eid: 123,
				evat: "2026-07-18T00:00:00.000Z",
				iat: now,
				exp: now + 60,
			})
		);

		expect(principal?.fplEntryId).toBe(123);
		expect(principal?.fplEntryVerifiedAt).toBe("2026-07-18T00:00:00.000Z");
	});

	test("rejects envelopes whose expiry is not after issuance", () => {
		const now = Math.floor(Date.now() / 1000);
		const principal = verifyWebsitePrincipal(
			signedHeaders({
				v: 2,
				aud: "letletme-graphql",
				uid: "user-1",
				iat: now,
				exp: now,
			})
		);

		expect(principal).toBeNull();
	});
});

describe("Mini Program session rollout compatibility", () => {
	test("does not turn the GraphQL service token into a user principal", async () => {
		let validationCalls = 0;
		const principal = await getPrincipalFromHeaders(
			new Headers({ "X-GraphQL-Service-Token": "s".repeat(43) }),
			{
				validateMiniProgramSessionToken: async () => {
					validationCalls += 1;
					return null;
				},
				validateApiSessionToken: async () => {
					validationCalls += 1;
					return null;
				},
			}
		);

		expect(principal).toBeNull();
		expect(validationCalls).toBe(0);
	});

	test("falls back to legacy validation when the Web-owned session table is absent", async () => {
		const legacyPrincipal = {
			userId: "legacy-user",
			source: "wechat_miniprogram" as const,
			provider: "wechat_miniprogram" as const,
			fplEntryId: 123,
			fplEntryVerifiedAt: "2026-07-18T00:00:00.000Z",
		};
		const principal = await getPrincipalFromHeaders(
			new Headers({ Authorization: "Bearer rollout-token" }),
			{
				validateMiniProgramSessionToken: async () => {
					throw Object.assign(new Error("relation does not exist"), { code: "42P01" });
				},
				validateApiSessionToken: async (token) => {
					expect(token).toBe("rollout-token");
					return legacyPrincipal;
				},
			}
		);

		expect(principal).toEqual(legacyPrincipal);
	});

	test("does not hide unrelated session lookup failures", async () => {
		await expect(
			getPrincipalFromHeaders(new Headers({ Authorization: "Bearer token" }), {
				validateMiniProgramSessionToken: async () => {
					throw Object.assign(new Error("database unavailable"), { code: "08006" });
				},
				validateApiSessionToken: async () => null,
			})
		).rejects.toThrow("database unavailable");
	});
});
