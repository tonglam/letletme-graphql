import { createHash } from "crypto";
import type { GraphQLContext } from "../graphql/context";

export const GRAPHQL_CACHE_NAMESPACE = "llm:gql";

const safeRevision = (value: string): string => {
	if (!/^[a-zA-Z0-9.-]+$/.test(value)) throw new Error("Invalid Data dataset revision");
	return value;
};

const queryName = (key: string): string => {
	const name = key
		.split(":")
		.slice(0, 2)
		.join("-")
		.replace(/[^a-zA-Z0-9_-]/g, "-");
	return name || "query";
};

export const gqlCacheKey = (
	context: GraphQLContext,
	key: string,
	datasetRevision = context.dataRevision
): string => {
	if (!datasetRevision) throw new Error("GraphQL query cache requires a Data dataset revision");
	const argsHash = createHash("sha256")
		.update(`${context.currentSeason.seasonCode}:${key}`, "utf8")
		.digest("hex")
		.slice(0, 32);
	return `${GRAPHQL_CACHE_NAMESPACE}:${safeRevision(datasetRevision)}:${queryName(key)}:${argsHash}`;
};
