import { describe, expect, it } from "bun:test";
import { createPublicLeagueTrendsRepository } from "../../../src/domains/public-league-trends/repository";
import { buildSnapshotContext, TestRedis } from "../../helpers/data-publication";

const enabled = process.env.RUN_DATABASE_CONTRACT_INTEGRATION === "1";

describe.skipIf(!enabled)("public league trends database contract", () => {
	it("executes the catalog query against the current Data Platform schema", async () => {
		const [{ database }, { closeDbPool }] = await Promise.all([
			import("../../../src/infra/database"),
			import("../../../src/infra/db-pool"),
		]);

		try {
			const repository = createPublicLeagueTrendsRepository(database);
			const context = buildSnapshotContext(new TestRedis());
			const result = await repository.list(context);

			expect(Array.isArray(result)).toBe(true);
		} finally {
			await closeDbPool();
		}
	});
});
