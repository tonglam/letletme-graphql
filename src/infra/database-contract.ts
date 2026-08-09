import type { QueryResultRow } from "pg";
import type { QueryExecutor } from "./database";
import { loadCurrentSeason, type CurrentSeason } from "./season";
import { V3ReadClient } from "./v3-read-client";
import {
	DATA_PLATFORM_PLAN_VERSION,
	DATA_PUBLICATION_SCHEMA_VERSION,
	isDataPublicationId,
} from "./data-publication";

const DATA_SCHEMAS = ["fpl", "competition", "reporting", "ops", "understat", "bridge"] as const;
const GRAPHQL_RUNTIME_CAPABILITY_ROLE = "letletme_graphql_reader";

type RoleRow = QueryResultRow & {
	session_user: string;
	role_name: string;
	server_version_num: number;
	rolcanlogin: boolean;
	rolsuper: boolean;
	rolcreatedb: boolean;
	rolcreaterole: boolean;
	rolinherit: boolean;
	rolreplication: boolean;
	rolbypassrls: boolean;
};

type CapabilityRoleRow = QueryResultRow & {
	role_name: string;
	rolcanlogin: boolean;
	rolsuper: boolean;
	rolcreatedb: boolean;
	rolcreaterole: boolean;
	rolinherit: boolean;
	rolreplication: boolean;
	rolbypassrls: boolean;
};

type InheritedRoleRow = QueryResultRow & {
	role_name: string;
};

type SchemaPrivilegeRow = QueryResultRow & {
	schema_name: string;
	has_usage: boolean;
	has_create: boolean;
};

type AuthContractPresenceRow = QueryResultRow & {
	schema_exists: boolean;
	user_exists: boolean;
	mini_program_session_exists: boolean;
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
					session_user::text AS session_user,
					current_user AS role_name,
					current_setting('server_version_num')::integer AS server_version_num,
					rolcanlogin,
					rolsuper,
					rolcreatedb,
					rolcreaterole,
					rolinherit,
					rolreplication,
					rolbypassrls
				FROM pg_roles
				WHERE rolname = current_user
			`)
		).rows,
		"The PostgreSQL runtime role cannot be resolved"
	);
	if (role.session_user !== role.role_name) {
		throw new DatabaseContractError(
			"The GraphQL runtime connection must not assume another PostgreSQL role"
		);
	}
	if (Math.floor(role.server_version_num / 10_000) !== 15) {
		throw new DatabaseContractError(
			`Data Platform v3 requires PostgreSQL 15; connected major is ${Math.floor(role.server_version_num / 10_000)}`
		);
	}
	if (
		!role.rolcanlogin ||
		!role.rolinherit ||
		role.rolsuper ||
		role.rolcreatedb ||
		role.rolcreaterole ||
		role.rolreplication ||
		role.rolbypassrls
	) {
		throw new DatabaseContractError(
			`PostgreSQL runtime role ${role.role_name} is not a dedicated non-admin LOGIN with INHERIT`
		);
	}

	const capabilityRole = expectOne(
		(
			await database.query<CapabilityRoleRow>(`
				SELECT
					rolname AS role_name,
					rolcanlogin,
					rolsuper,
					rolcreatedb,
					rolcreaterole,
					rolinherit,
					rolreplication,
					rolbypassrls
				FROM pg_roles
				WHERE rolname = '${GRAPHQL_RUNTIME_CAPABILITY_ROLE}'
			`)
		).rows,
		"The GraphQL runtime capability role cannot be resolved"
	);
	if (
		capabilityRole.role_name !== GRAPHQL_RUNTIME_CAPABILITY_ROLE ||
		capabilityRole.rolcanlogin ||
		capabilityRole.rolinherit ||
		capabilityRole.rolsuper ||
		capabilityRole.rolcreatedb ||
		capabilityRole.rolcreaterole ||
		capabilityRole.rolreplication ||
		capabilityRole.rolbypassrls
	) {
		throw new DatabaseContractError("The GraphQL runtime capability role has unsafe attributes");
	}

	const inheritedRoles = (
		await database.query<InheritedRoleRow>(`
			SELECT inherited_roles.role_name
			FROM (
				WITH RECURSIVE inherited(role_oid, role_name, path) AS (
					SELECT granted_role.oid, granted_role.rolname, ARRAY[member_role.oid, granted_role.oid]
					FROM pg_auth_members membership
					JOIN pg_roles member_role ON member_role.oid = membership.member
					JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
					WHERE member_role.rolname = current_user

					UNION ALL

					SELECT granted_role.oid, granted_role.rolname, inherited.path || granted_role.oid
					FROM inherited
					JOIN pg_auth_members membership ON membership.member = inherited.role_oid
					JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
					WHERE NOT granted_role.oid = ANY(inherited.path)
				)
				SELECT DISTINCT role_name
				FROM inherited
			) inherited_roles
			ORDER BY inherited_roles.role_name
		`)
	).rows.map((row) => row.role_name);
	if (inheritedRoles.length !== 1 || inheritedRoles[0] !== GRAPHQL_RUNTIME_CAPABILITY_ROLE) {
		throw new DatabaseContractError(
			`The GraphQL runtime LOGIN must inherit only ${GRAPHQL_RUNTIME_CAPABILITY_ROLE}`
		);
	}

	const authContractPresence = (
		await database.query<AuthContractPresenceRow>(
			`SELECT
					EXISTS (
						SELECT 1 FROM pg_namespace WHERE nspname = 'bauth'
					) AS schema_exists,
					EXISTS (
						SELECT 1
						FROM pg_class relation
						JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
						WHERE namespace.nspname = 'bauth' AND relation.relname = 'user'
					) AS user_exists,
					EXISTS (
						SELECT 1
						FROM pg_class relation
						JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
						WHERE namespace.nspname = 'bauth' AND relation.relname = 'mini_program_session'
					) AS mini_program_session_exists`
		)
	).rows[0];
	const authContractPresent =
		authContractPresence?.schema_exists === true &&
		(authContractPresence.user_exists === true ||
			authContractPresence.mini_program_session_exists === true);
	const requiredSchemas = [
		...DATA_SCHEMAS,
		...(authContractPresent ? ["bauth" as const] : []),
	].sort();
	const schemaPrivileges = (
		await database.query<SchemaPrivilegeRow>(
			`SELECT
				schema_name,
				has_schema_privilege(current_user, schema_name, 'USAGE') AS has_usage,
				has_schema_privilege(current_user, schema_name, 'CREATE') AS has_create
			 FROM unnest($1::text[]) AS schema_name
			 ORDER BY schema_name`,
			[requiredSchemas]
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
			// Used only when Redis has no coherent core publication.
			"fpl.phases",
			"competition.public_league_trends",
			"ops.dataset_publications",
			...(authContractPresent ? ['bauth."user"', "bauth.mini_program_session"] : []),
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
	if (!isDataPublicationId(publication.publication_id)) {
		throw new DatabaseContractError("The active Data publication has an invalid RFC UUID");
	}
	if (
		schemaVersion !== DATA_PUBLICATION_SCHEMA_VERSION ||
		planVersion !== DATA_PLATFORM_PLAN_VERSION
	) {
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
