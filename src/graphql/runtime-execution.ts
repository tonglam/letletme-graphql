import {
	ApolloServer,
	HeaderMap,
	type GraphQLRequestListener,
	type GraphQLRequestListenerParsingDidEnd,
	type GraphQLRequestListenerValidationDidEnd,
} from "@apollo/server";
import depthLimit from "graphql-depth-limit";
import { sanitizeGraphQLMultipartChunk, sanitizeGraphQLResponseBody } from "../http/graphql-error";
import { env } from "../infra/env";
import { logger } from "../infra/logger";
import type { RequestTiming } from "../http/request-timing";
import { metrics } from "../infra/metrics";
import type { GraphQLContext } from "./context";
import { createDeprecatedSchemaUsageExecutionListener } from "./deprecation-observability";
import { schema } from "./schema";

export const createGraphQLApolloServer = (): ApolloServer<GraphQLContext> =>
	new ApolloServer<GraphQLContext>({
		schema,
		introspection: !env.isProduction,
		validationRules: [depthLimit(10)],
		plugins: [
			{
				async requestDidStart(): Promise<GraphQLRequestListener<GraphQLContext>> {
					let executionHadErrors = false;
					let deferredDeprecatedGlobalCommit: (() => void) | undefined;
					return {
						async parsingDidStart(requestContext): Promise<GraphQLRequestListenerParsingDidEnd> {
							const stop = requestContext.contextValue.requestTiming?.start("apolloParse");
							return async (): Promise<void> => {
								stop?.();
							};
						},
						async validationDidStart(
							requestContext
						): Promise<GraphQLRequestListenerValidationDidEnd> {
							const stop = requestContext.contextValue.requestTiming?.start("apolloValidate");
							return async (): Promise<void> => {
								stop?.();
							};
						},
						async didEncounterErrors(): Promise<void> {
							executionHadErrors = true;
						},
						async willSendResponse(): Promise<void> {
							// Global deprecated symbols are committed only after Apollo has
							// dispatched didEncounterErrors. This prevents variable-coercion
							// failures, which execute no resolver, from being counted as
							// successful usage.
							deferredDeprecatedGlobalCommit?.();
							deferredDeprecatedGlobalCommit = undefined;
						},
						async executionDidStart(requestContext) {
							const stop = requestContext.contextValue.requestTiming?.start("apolloExecute");
							// Apollo skips validationDidStart for document-cache hits and performs variable
							// coercion only after executionDidStart. The first resolver hook is therefore
							// the earliest lifecycle point that covers cached documents while proving both
							// document validation and variable coercion succeeded.
							return createDeprecatedSchemaUsageExecutionListener<GraphQLContext>({
								symbols: requestContext.contextValue.deprecatedSymbols ?? [],
								symbolOwners: requestContext.contextValue.deprecatedSymbolOwners ?? {},
								globalSymbols: requestContext.contextValue.deprecatedSymbolGlobalSymbols ?? [],
								increment: (symbol) => metrics.graphqlDeprecatedSchemaUsages.labels(symbol).inc(),
								isExecutionSuccessful: () =>
									!executionHadErrors && !(requestContext.errors?.length ?? 0),
								deferGlobalSymbols: true,
								registerDeferredGlobalCommit: (commit) => {
									deferredDeprecatedGlobalCommit = commit;
								},
								onExecutionEnd: stop,
							});
						},
					};
				},
			},
		],
	});

export type GraphQLExecutionResult = Readonly<{
	response: Response;
	hasErrors: boolean;
}>;

export const executeGraphQLRequest = async ({
	apollo,
	request,
	parsedBody,
	context,
	requestTiming,
	requestId,
	corsHeaders,
}: {
	apollo: ApolloServer<GraphQLContext>;
	request: Request;
	parsedBody: unknown;
	context: GraphQLContext;
	requestTiming: RequestTiming;
	requestId: string;
	corsHeaders: Record<string, string>;
}): Promise<GraphQLExecutionResult> => {
	const headers = new HeaderMap();
	request.headers.forEach((value, key) => {
		headers.set(key, value);
	});

	const httpGraphQLResponse = await requestTiming.measure("apollo", () =>
		apollo.executeHTTPGraphQLRequest({
			httpGraphQLRequest: {
				method: request.method.toUpperCase(),
				headers,
				body: parsedBody,
				search: "",
			},
			context: async () => context,
		})
	);

	const stopResponseBuild = requestTiming.start("responseBuild");
	const responseHeaders: Record<string, string> = {};
	for (const [key, value] of httpGraphQLResponse.headers) {
		responseHeaders[key] = value;
	}

	let responseBody: string | ReadableStream;
	let hasErrors = false;
	if (httpGraphQLResponse.body.kind === "complete") {
		responseBody = sanitizeGraphQLResponseBody(httpGraphQLResponse.body.string, requestId);
		try {
			const parsed = JSON.parse(responseBody) as { errors?: unknown };
			hasErrors = Array.isArray(parsed.errors) && parsed.errors.length > 0;
		} catch {
			hasErrors = true;
		}
	} else {
		const { asyncIterator } = httpGraphQLResponse.body;
		responseBody = new ReadableStream({
			async start(controller): Promise<void> {
				try {
					for await (const chunk of asyncIterator) {
						controller.enqueue(
							new TextEncoder().encode(sanitizeGraphQLMultipartChunk(chunk, requestId))
						);
					}
					controller.close();
				} catch (error) {
					logger.error({ err: error, requestId }, "GraphQL multipart response sanitization failed");
					controller.error(error);
				}
			},
		});
	}

	const response = new Response(responseBody, {
		status: httpGraphQLResponse.status || 200,
		headers: {
			...responseHeaders,
			...corsHeaders,
			"X-Request-Id": requestId,
		},
	});
	stopResponseBuild();
	return { response, hasErrors };
};
