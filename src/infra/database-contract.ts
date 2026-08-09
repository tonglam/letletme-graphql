import type { QueryResultRow } from "pg";
import type { QueryExecutor } from "./database";
import { loadCurrentSeason, type CurrentSeason } from "./season";
import { V3ReadClient } from "./v3-read-client";

const REQUIRED_SCHEMA_VERSION = "v3";
const REQUIRED_PLAN_VERSION = "3.2.3";
const DATA_SCHEMAS = ["fpl", "competition", "reporting", "ops", "understat", "bridge"] as const;

type RoleRow = QueryResultRow & {
	role_name: string;
	server_version_num: number;
	rolsuper: boolean;
	rolcreatedb: boolean;
	rolcreaterole: boolean;
	rolbypassrls: boolean;
};

type SchemaPrivilegeRow = QueryResultRow & {
	schema_name: string;
	has_usage: boolean;
	has_create: boolean;
};

type RelationPrivilegeRow = QueryResultRow & {
	relation_name: string;
	relation_exists: boolean;
	readable: boolean;
	writable: boolean;
};

type WritePrivilegeRow = QueryResultRow & {
	writable_relations: string[] | null;
};

type PublicationRow = QueryResultRow & {
	publication_id: string;
	revision: string;
	manifest: Record<string, unknown>;
};

export type DatabaseContractSnapshot = Readonly<{
	roleName: string;
	currentSeason: CurrentSeason;
	publicationId: string;
	datasetRevision: string;
	schemaVersion: string;
	planVersion: string;
}>;

export class DatabaseContractError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "DatabaseContractError";
	}
}

const expectOne = <Row>(rows: readonly Row[], message: string): Row => {
	if (rows.length !== 1) throw new DatabaseContractError(message);
	return rows[0];
};

export const validateDatabaseContract = async (
	database: QueryExecutor
): Promise<DatabaseContractSnapshot> => {
	const currentSeason = await loadCurrentSeason(database);

	const role = expectOne(
		(
			await database.query<RoleRow>(`
				SELECT
					current_user AS role_name,
					current_setting('server_version_num')::integer AS server_version_num,
					rolsuper,
					rolcreatedb,
					rolcreaterole,
					rolbypassrls
				FROM pg_roles
				WHERE rolname = current_user
			`)
		).rows,
		"The PostgreSQL runtime role cannot be resolved"
	);
	if (Math.floor(role.server_version_num / 10_000) !== 15) {
		throw new DatabaseContractError(
			`Data Platform v3 requires PostgreSQL 15; connected major is ${Math.floor(role.server_version_num / 10_000)}`
		);
	}
	if (role.rolsuper || role.rolcreatedb || role.rolcreaterole || role.rolbypassrls) {
		throw new DatabaseContractError(
			`PostgreSQL runtime role ${role.role_name} has unsafe role attributes`
		);
	}

	const schemaPrivileges = (
		await database.query<SchemaPrivilegeRow>(
			`SELECT
				schema_name,
				has_schema_privilege(current_user, schema_name, 'USAGE') AS has_usage,
				has_schema_privilege(current_user, schema_name, 'CREATE') AS has_create
			 FROM unnest($1::text[]) AS schema_name
			 ORDER BY schema_name`,
			[DATA_SCHEMAS]
		)
	).rows;
	const unsafeSchema = schemaPrivileges.find((row) => !row.has_usage || row.has_create);
	if (unsafeSchema) {
		throw new DatabaseContractError(
			`PostgreSQL runtime role has an invalid ${unsafeSchema.schema_name} schema boundary`
		);
	}

	const requiredRelations = [
		...new Set([
			...V3ReadClient.sourceRelations(),
			"competition.public_league_trends",
			"ops.dataset_publications",
		]),
	].sort();
	const relationPrivileges = (
		await database.query<RelationPrivilegeRow>(
			`SELECT
				relation_name,
				to_regclass(relation_name) IS NOT NULL AS relation_exists,
				CASE
					WHEN to_regclass(relation_name) IS NULL THEN FALSE
					ELSE has_table_privilege(current_user, relation_name, 'SELECT')
				END AS readable,
				CASE
					WHEN to_regclass(relation_name) IS NULL THEN FALSE
					ELSE has_table_privilege(current_user, relation_name, 'INSERT')
					  OR has_table_privilege(current_user, relation_name, 'UPDATE')
					  OR has_table_privilege(current_user, relation_name, 'DELETE')
					  OR has_table_privilege(current_user, relation_name, 'TRUNCATE')
					  OR has_table_privilege(current_user, relation_name, 'REFERENCES')
					  OR has_table_privilege(current_user, relation_name, 'TRIGGER')
				END AS writable
			 FROM unnest($1::text[]) AS relation_name
			 ORDER BY relation_name`,
			[requiredRelations]
		)
	).rows;
	const invalidRelation = relationPrivileges.find(
		(row) => !row.relation_exists || !row.readable || row.writable
	);
	if (invalidRelation) {
		throw new DatabaseContractError(
			`PostgreSQL runtime role has an invalid ${invalidRelation.relation_name} relation boundary`
		);
	}

	const writePrivileges = expectOne(
		(
			await database.query<WritePrivilegeRow>(
				`SELECT ARRAY_AGG(format('%I.%I', namespace.nspname, relation.relname) ORDER BY 1)
					FILTER (WHERE
						has_table_privilege(current_user, relation.oid, 'INSERT')
						OR has_table_privilege(current_user, relation.oid, 'UPDATE')
						OR has_table_privilege(current_user, relation.oid, 'DELETE')
						OR has_table_privilege(current_user, relation.oid, 'TRUNCATE')
						OR has_table_privilege(current_user, relation.oid, 'REFERENCES')
						OR has_table_privilege(current_user, relation.oid, 'TRIGGER')
					) AS writable_relations
				 FROM pg_class relation
				 JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
				 WHERE namespace.nspname = ANY($1::text[])
				   AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')`,
				[DATA_SCHEMAS]
			)
		).rows,
		"The PostgreSQL write boundary cannot be resolved"
	);
	if ((writePrivileges.writable_relations ?? []).length > 0) {
		throw new DatabaseContractError(
			`PostgreSQL runtime role can mutate Data-owned relations: ${writePrivileges.writable_relations?.join(", ")}`
		);
	}

	const publication = expectOne(
		(
			await database.query<PublicationRow>(
				`SELECT publication_id::text, revision::text, manifest
				 FROM ops.dataset_publications
				 WHERE dataset = 'fpl:core'
				   AND season_id = $1
				   AND event_id IS NULL
				   AND status = 'active'
				 ORDER BY revision DESC
				 LIMIT 2`,
				[currentSeason.seasonId]
			)
		).rows,
		"Exactly one active fpl:core publication is required"
	);
	const schemaVersion = publication.manifest.schemaVersion;
	const planVersion = publication.manifest.planVersion;
	if (schemaVersion !== REQUIRED_SCHEMA_VERSION || planVersion !== REQUIRED_PLAN_VERSION) {
		throw new DatabaseContractError(
			`Unsupported Data Platform contract ${String(schemaVersion)}/${String(planVersion)}`
		);
	}

	await new V3ReadClient(database, currentSeason).probe();

	return {
		roleName: role.role_name,
		currentSeason,
		publicationId: publication.publication_id,
		datasetRevision: publication.revision,
		schemaVersion,
		planVersion,
	};
};
