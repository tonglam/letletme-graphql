import { describe, expect, it } from "bun:test";
import type { QueryExecutor } from "../../src/infra/database";
import { DatabaseContractError, validateDatabaseContract } from "../../src/infra/database-contract";

type ContractOptions = Readonly<{
	missingRelation?: string;
	writableRelation?: string;
	writableRelations?: readonly string[];
	probeFailure?: boolean;
	authMissingRelation?: string;
	authTableReadable?: string;
	authMissingColumn?: string;
	authExtraReadableColumn?: string;
	authWritableColumn?: string;
	invalidManifest?: boolean;
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

const CORE_ITEM_NAMES = ["events", "teams", "players", "phases", "fixtures", "currentEventId"];

const makeCoreManifest = (invalid = false): Record<string, unknown> => ({
	dataset: "fpl:core",
	seasonCode: "2627",
	eventId: null,
	revision: 7,
	publicationId: "00000000-0000-4000-8000-000000000007",
	sourceCheckedAt: "2026-08-10T00:00:00.000Z",
	publishedAt: "2026-08-10T00:00:01.000Z",
	state: "active",
	items: CORE_ITEM_NAMES.map((name) => ({
		name,
		key: `llm:data:fpl:core:2627:7:${name}`,
		type: "string",
		count: 0,
		bytes: 2,
		sha256: "0".repeat(64),
	})),
	...(invalid ? { unexpectedField: true } : {}),
});

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
			if (text.includes("WHERE rolname = $1")) {
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
			if (
				text.includes("to_regclass(relation_name)") &&
				(values[0] as readonly string[]).includes('bauth."user"')
			) {
				const relations = values[0] as readonly string[];
				return {
					rows: relations.map((relation_name) => ({
						relation_name,
						relation_exists: relation_name !== options.authMissingRelation,
						readable: relation_name === options.authTableReadable,
						writable: relation_name === options.writableRelation,
					})),
					rowCount: relations.length,
				} as never;
			}
			if (text.includes("has_column_privilege")) {
				const expectedColumns = new Set([
					'bauth."user".id',
					'bauth."user".fpl_entry_id',
					'bauth."user".fpl_entry_verified_at',
					'bauth."user".fpl_entry_season',
					'bauth."user".fpl_entry_binding_assurance',
					'bauth."user".fpl_entry_binding_proof_kind',
					"bauth.mini_program_session.user_id",
					"bauth.mini_program_session.token_hash",
					"bauth.mini_program_session.revoked_at",
					"bauth.mini_program_session.expires_at",
				]);
				const physicalColumns = [
					['bauth."user"', "id"],
					['bauth."user"', "email"],
					['bauth."user"', "fpl_entry_id"],
					['bauth."user"', "fpl_entry_verified_at"],
					['bauth."user"', "fpl_entry_season"],
					['bauth."user"', "fpl_entry_binding_assurance"],
					['bauth."user"', "fpl_entry_binding_proof_kind"],
					["bauth.mini_program_session", "id"],
					["bauth.mini_program_session", "user_id"],
					["bauth.mini_program_session", "token_hash"],
					["bauth.mini_program_session", "revoked_at"],
					["bauth.mini_program_session", "expires_at"],
					["bauth.mini_program_session", "device_id"],
				] as const;
				const rows = physicalColumns
					.map(([relation_name, column_name]) => {
						const key = `${relation_name}.${column_name}`;
						return {
							relation_name,
							column_name,
							readable: expectedColumns.has(key) || key === options.authExtraReadableColumn,
							writable: key === options.authWritableColumn,
						};
					})
					.filter((row) => `${row.relation_name}.${row.column_name}` !== options.authMissingColumn);
				return { rows, rowCount: rows.length } as never;
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
				const publicationId = options.publicationId ?? "00000000-0000-4000-8000-000000000007";
				const manifest = makeCoreManifest(options.invalidManifest);
				manifest.publicationId = publicationId;
				return {
					rows: [
						{
							publication_id: publicationId,
							revision: "7",
							manifest,
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
	it("accepts the exact canonical publication through SELECT-only startup queries", async () => {
		const { executor, queries } = makeContractExecutor();
		await expect(validateDatabaseContract(executor)).resolves.toEqual({
			roleName: "graphql_runtime",
			currentSeason: { seasonId: 2026, seasonCode: "2627" },
			publicationId: "00000000-0000-4000-8000-000000000007",
			datasetRevision: "7",
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

	it("requires read access to Web Mini Program auth relations", async () => {
		const { executor } = makeContractExecutor({
			authMissingRelation: "bauth.mini_program_session",
		});
		await expect(validateDatabaseContract(executor)).rejects.toThrow(
			"invalid bauth.mini_program_session auth relation boundary"
		);
	});

	it("accepts only the ten Web auth columns used by GraphQL", async () => {
		const { executor } = makeContractExecutor();
		await expect(validateDatabaseContract(executor)).resolves.toMatchObject({
			roleName: "graphql_runtime",
		});
	});

	it("rejects broad or extra Web auth read access", async () => {
		const tableReader = makeContractExecutor({
			authTableReadable: 'bauth."user"',
		});
		await expect(validateDatabaseContract(tableReader.executor)).rejects.toThrow(
			'invalid bauth."user" auth relation boundary'
		);

		const extraColumnReader = makeContractExecutor({
			authExtraReadableColumn: 'bauth."user".email',
		});
		await expect(validateDatabaseContract(extraColumnReader.executor)).rejects.toThrow(
			'invalid bauth."user".email auth column boundary'
		);
	});

	it("rejects missing or writable Web auth columns", async () => {
		const missingSeason = makeContractExecutor({
			authMissingColumn: 'bauth."user".fpl_entry_season',
		});
		await expect(validateDatabaseContract(missingSeason.executor)).rejects.toThrow(
			'invalid bauth."user".fpl_entry_season auth column boundary'
		);

		const missingColumn = makeContractExecutor({
			authMissingColumn: "bauth.mini_program_session.expires_at",
		});
		await expect(validateDatabaseContract(missingColumn.executor)).rejects.toThrow(
			"invalid bauth.mini_program_session.expires_at auth column boundary"
		);

		const writableColumn = makeContractExecutor({
			authWritableColumn: "bauth.mini_program_session.revoked_at",
		});
		await expect(validateDatabaseContract(writableColumn.executor)).rejects.toThrow(
			"invalid bauth.mini_program_session.revoked_at auth column boundary"
		);
	});

	it("fails closed when a required read-model column is missing", async () => {
		const { executor } = makeContractExecutor({ probeFailure: true });
		await expect(validateDatabaseContract(executor)).rejects.toThrow(
			"Data Platform read model is unavailable"
		);
	});

	it("fails closed for a non-canonical Data publication contract", async () => {
		const { executor } = makeContractExecutor({ invalidManifest: true });
		await expect(validateDatabaseContract(executor)).rejects.toThrow(
			"active Data publication manifest is not canonical"
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
			"Data Platform requires PostgreSQL 15; connected major is 16"
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
