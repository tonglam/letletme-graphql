import { describe, expect, it } from "bun:test";
import type { QueryExecutor } from "../../src/infra/database";
import { DatabaseContractError, validateDatabaseContract } from "../../src/infra/database-contract";

type ContractOptions = Readonly<{
	missingRelation?: string;
	writableRelation?: string;
	writableRelations?: readonly string[];
	probeFailure?: boolean;
	authSchemaPresent?: boolean;
	authUserPresent?: boolean;
	authMiniProgramSessionPresent?: boolean;
	authMissingRelation?: string;
	schemaVersion?: string;
	planVersion?: string;
	publicationId?: string;
	serverVersionNum?: number;
	unsafeRole?: boolean;
	sessionUser?: string;
	runtimeCanLogin?: boolean;
	runtimeInherit?: boolean;
	runtimeReplication?: boolean;
	unsafeCapability?: boolean;
	inheritedRoles?: readonly string[];
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
			if (text.includes("WHERE rolname = current_user")) {
				return {
					rows: [
						{
							session_user: options.sessionUser ?? "graphql_runtime",
							role_name: "graphql_runtime",
							server_version_num: options.serverVersionNum ?? 150_000,
							rolcanlogin: options.runtimeCanLogin ?? true,
							rolsuper: options.unsafeRole ?? false,
							rolcreatedb: false,
							rolcreaterole: false,
							rolinherit: options.runtimeInherit ?? true,
							rolreplication: options.runtimeReplication ?? false,
							rolbypassrls: false,
						},
					],
					rowCount: 1,
				} as never;
			}
			if (text.includes("WHERE rolname = 'letletme_graphql_reader'")) {
				return {
					rows: [
						{
							role_name: "letletme_graphql_reader",
							rolcanlogin: options.unsafeCapability ?? false,
							rolsuper: false,
							rolcreatedb: false,
							rolcreaterole: false,
							rolinherit: false,
							rolreplication: false,
							rolbypassrls: false,
						},
					],
					rowCount: 1,
				} as never;
			}
			if (text.includes("WITH RECURSIVE inherited")) {
				const inheritedRoles = options.inheritedRoles ?? ["letletme_graphql_reader"];
				return {
					rows: inheritedRoles.map((role_name) => ({ role_name })),
					rowCount: inheritedRoles.length,
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
			if (text.includes("to_regnamespace('bauth')")) {
				return {
					rows: [
						{
							schema_exists: options.authSchemaPresent ?? false,
							user_exists: options.authUserPresent ?? options.authSchemaPresent ?? false,
							mini_program_session_exists:
								options.authMiniProgramSessionPresent ?? options.authSchemaPresent ?? false,
						},
					],
					rowCount: 1,
				} as never;
			}
			if (text.includes("to_regclass(relation_name)")) {
				const relations = values[0] as readonly string[];
				const missingRelation = options.authMissingRelation ?? options.missingRelation;
				return {
					rows: relations.map((relation_name) => ({
						relation_name,
						relation_exists: relation_name !== missingRelation,
						readable: relation_name !== missingRelation,
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
							publication_id: options.publicationId ?? "00000000-0000-4000-8000-000000000007",
							revision: "7",
							manifest: {
								schemaVersion: options.schemaVersion ?? "v3",
								planVersion: options.planVersion ?? "3.2.5",
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
			publicationId: "00000000-0000-4000-8000-000000000007",
			datasetRevision: "7",
			schemaVersion: "v3",
			planVersion: "3.2.5",
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

	it("requires read access to Web Mini Program auth relations when bauth exists", async () => {
		const { executor } = makeContractExecutor({
			authSchemaPresent: true,
			authUserPresent: true,
			authMiniProgramSessionPresent: true,
			authMissingRelation: "bauth.mini_program_session",
		});
		await expect(validateDatabaseContract(executor)).rejects.toThrow(
			"invalid bauth.mini_program_session relation boundary"
		);
	});

	it("fails closed when a required read-model column is missing", async () => {
		const { executor } = makeContractExecutor({ probeFailure: true });
		await expect(validateDatabaseContract(executor)).rejects.toThrow(
			"Data Platform v3 read model is unavailable"
		);
	});

	it("fails closed for an unsupported Data publication contract", async () => {
		const { executor } = makeContractExecutor({ planVersion: "3.2.3" });
		await expect(validateDatabaseContract(executor)).rejects.toThrow(
			"Unsupported Data Platform contract v3/3.2.3"
		);
	});

	it("fails closed for a non-RFC active publication identity", async () => {
		const { executor } = makeContractExecutor({ publicationId: "publication-1" });
		await expect(validateDatabaseContract(executor)).rejects.toThrow(
			"active Data publication has an invalid RFC UUID"
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

	it("rejects assumed identities and any runtime membership beyond the GraphQL reader", async () => {
		const assumedIdentity = makeContractExecutor({ sessionUser: "postgres" });
		await expect(validateDatabaseContract(assumedIdentity.executor)).rejects.toThrow(
			"must not assume another PostgreSQL role"
		);

		const extraMembership = makeContractExecutor({
			inheritedRoles: ["letletme_graphql_reader", "pg_read_all_data"],
		});
		await expect(validateDatabaseContract(extraMembership.executor)).rejects.toThrow(
			"must inherit only letletme_graphql_reader"
		);

		const unsafeCapability = makeContractExecutor({ unsafeCapability: true });
		await expect(validateDatabaseContract(unsafeCapability.executor)).rejects.toThrow(
			"capability role has unsafe attributes"
		);
	});
});
