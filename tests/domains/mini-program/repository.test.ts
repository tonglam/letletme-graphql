import { describe, expect, it } from "bun:test";
import {
	MINI_PROGRAM_NOTICE_REDIS_KEY,
	miniProgramRepository,
} from "../../../src/domains/mini-program/repository";
import type { GraphQLContext } from "../../../src/graphql/context";

const makeContext = (hash: Record<string, string>): GraphQLContext =>
	({
		redis: {
			hgetall: async (key: string): Promise<Record<string, string>> =>
				key === MINI_PROGRAM_NOTICE_REDIS_KEY ? hash : {},
		},
		supabase: {} as GraphQLContext["supabase"],
		logger: {
			info: () => undefined,
			warn: () => undefined,
			error: () => undefined,
		},
		user: undefined,
	}) as unknown as GraphQLContext;

describe("miniProgramRepository.getMiniProgramNotice", () => {
	it("returns empty string when hash is empty", async () => {
		const ctx = makeContext({});
		await expect(miniProgramRepository.getMiniProgramNotice(ctx)).resolves.toBe(
			"",
		);
	});

	it("returns empty string when switch is not ON (case-insensitive)", async () => {
		const ctx = makeContext({ switch: "OFF", content: "hello" });
		await expect(miniProgramRepository.getMiniProgramNotice(ctx)).resolves.toBe(
			"",
		);
	});

	it("returns content when switch is ON", async () => {
		const ctx = makeContext({ switch: "ON", content: "Maintenance tonight" });
		await expect(miniProgramRepository.getMiniProgramNotice(ctx)).resolves.toBe(
			"Maintenance tonight",
		);
	});

	it("treats switch as ON case-insensitively", async () => {
		const ctx = makeContext({ switch: "on", content: "x" });
		await expect(miniProgramRepository.getMiniProgramNotice(ctx)).resolves.toBe(
			"x",
		);
	});

	it("returns empty string when switch ON but content field missing", async () => {
		const ctx = makeContext({ switch: "ON" });
		await expect(miniProgramRepository.getMiniProgramNotice(ctx)).resolves.toBe(
			"",
		);
	});
});
