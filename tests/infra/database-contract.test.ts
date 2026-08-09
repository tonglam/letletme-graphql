import { describe, expect, it } from "bun:test";
import type { QueryExecutor } from "../../src/infra/database";
import { DatabaseContractError, validateDatabaseContract } from "../../src/infra/database-contract";

type ContractOptions = Readonly<{
	missingRelation?: string;
	writableRelation?: string;
	writableRelations?: readonly string[];
	probeFailure?: boolean;
	schemaVersion?: string;
	planVersion?: string;
	serverVersionNum?: number;
	unsafeRole?: boolean;
}>;

const makeContractExecutor = (
	options: ContractOptions = {}
): Readonly<{ executor: QueryExecutor; queries: string[] }> => {
	const queries: string[] = [];
	const executor: QueryExecutor = {
		query: async (text, values = []) => {
			queries.push(text);
			if (text.includes("FROM fpl.seasons")) {
				return {
					rows: [{ season_id: 2026, season_code: "2627" }],
					rowCount: 1,
				} as never;
			}
			if (text.includes("FROM pg_roles")) {
				return {
					rows: [
						{
							role_name: "graphql_runtime",
							server_version_num: options.serverVersionNum ?? 150_000,
							rolsuper: options.unsafeRole ?? false,
							rolcreatedb: false,
							rolcreaterole: false,
							rolbypassrls: false,
						},
					],
					rowCount: 1,
				} as never;
			}
			if (text.includes("has_schema_privilege")) {
				const schemas = values[0] as readonly string[];
				return {
					rows: schemas.map((schema_name) => ({
						schema_name,
						has_usage: true,
						has_create: false,
					})),
					rowCount: schemas.length,
				} as never;
			}
			if (text.includes("to_regclass(relation_name)")) {
				const relations = values[0] as readonly string[];
				return {
					rows: relations.map((relation_name) => ({
						relation_name,
						relation_exists: relation_name !== options.missingRelation,
						readable: relation_name !== options.missingRelation,
						writable: relation_name === options.writableRelation,
					})),
					rowCount: relations.length,
				} as never;
			}
			if (text.includes("ARRAY_AGG(format")) {
				return {
					rows: [{ writable_relations: options.writableRelations ?? null }],
					rowCount: 1,
				} as never;
			}
			if (text.includes("FROM ops.dataset_publications")) {
				return {
					rows: [
						{
							publication_id: "publication-1",
							revision: "7",
							manifest: {
								schemaVersion: options.schemaVersion ?? "v3",
								planVersion: options.planVersion ?? "3.2.3",
							},
						},
					],
					rowCount: 1,
				} as never;
			}
			if (options.probeFailure && text.includes("AS read_model LIMIT 0")) {
				throw Object.assign(new Error("missing read-model column"), { code: "42703" });
			}
			return { rows: [], rowCount: 0 } as never;
		},
	};
	return { executor, queries };
};

describe("GraphQL startup database contract", () => {
	it("accepts the exact v3 publication through SELECT-only startup queries", async () => {
		const { executor, queries } = makeContractExecutor();
		await expect(validateDatabaseContract(executor)).resolves.toEqual({
			roleName: "graphql_runtime",
			currentSeason: { seasonId: 2026, seasonCode: "2627" },
			publicationId: "publication-1",
			datasetRevision: "7",
			schemaVersion: "v3",
			planVersion: "3.2.3",
		});

		expect(queries.length).toBeGreaterThan(20);
		expect(queries.every((query) => query.trimStart().startsWith("SELECT"))).toBe(true);
	});

	it("fails closed when a required relation is missing", async () => {
		const { executor } = makeContractExecutor({ missingRelation: "fpl.players" });
		await expect(validateDatabaseContract(executor)).rejects.toThrow(
			"invalid fpl.players relation boundary"
		);
	});

	it("fails closed when a required read-model column is missing", async () => {
		const { executor } = makeContractExecutor({ probeFailure: true });
		await expect(validateDatabaseContract(executor)).rejects.toThrow(
			"Data Platform v3 read model is unavailable"
		);
	});

	it("fails closed for an unsupported Data publication contract", async () => {
		const { executor } = makeContractExecutor({ planVersion: "3.2.2" });
		await expect(validateDatabaseContract(executor)).rejects.toThrow(
			"Unsupported Data Platform contract v3/3.2.2"
		);
	});

	it("fails closed on a PostgreSQL major other than 15", async () => {
		const { executor } = makeContractExecutor({ serverVersionNum: 160_000 });
		await expect(validateDatabaseContract(executor)).rejects.toThrow(
			"Data Platform v3 requires PostgreSQL 15; connected major is 16"
		);
	});

	it("rejects privileged and Data-write-capable runtime roles", async () => {
		const privileged = makeContractExecutor({ unsafeRole: true });
		await expect(validateDatabaseContract(privileged.executor)).rejects.toBeInstanceOf(
			DatabaseContractError
		);

		const writer = makeContractExecutor({ writableRelations: ["fpl.events"] });
		await expect(validateDatabaseContract(writer.executor)).rejects.toThrow(
			"can mutate Data-owned relations: fpl.events"
		);
	});
});
