export type GraphQLTransportFailure = Readonly<{
	code: "BATCHING_DISABLED" | "INVALID_GRAPHQL_REQUEST";
	message: string;
}>;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Reflect.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
};

export const validateGraphQLTransportPayload = (body: unknown): GraphQLTransportFailure | null => {
	if (Array.isArray(body)) {
		return {
			code: "BATCHING_DISABLED",
			message: "GraphQL request batching is disabled",
		};
	}
	if (!isPlainObject(body) || typeof body.query !== "string" || body.query.trim().length === 0) {
		return {
			code: "INVALID_GRAPHQL_REQUEST",
			message: "GraphQL request body must contain a non-empty query string",
		};
	}
	return null;
};
