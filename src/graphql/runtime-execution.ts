import { createHash } from "node:crypto";
import {
	ApolloServer,
	HeaderMap,
	type GraphQLRequestListener,
	type GraphQLRequestListenerParsingDidEnd,
	type GraphQLRequestListenerValidationDidEnd,
} from "@apollo/server";
import depthLimit from "graphql-depth-limit";
import { sanitizeGraphQLMultipartChunk, sanitizeGraphQLResponseBody } from "../http/graphql-error";
import { ExecutionScope } from "../infra/execution-scope";
import { createDatabaseExecutor } from "../infra/database";
import { ReadModelClient } from "../infra/read-model-client";
import { env } from "../infra/env";
import { logger } from "../infra/logger";
import type { RequestTiming } from "../http/request-timing";
import { metrics } from "../infra/metrics";
import type { GraphQLContext, LiveMatchExecutionObservation } from "./context";
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

type ApolloHttpGraphQLResponse = Awaited<
	ReturnType<ApolloServer<GraphQLContext>["executeHTTPGraphQLRequest"]>
>;

type CompleteApolloResponse = Readonly<{
	status: number;
	headers: readonly [string, string][];
	body: string;
	observation: LiveMatchExecutionObservation;
}>;

type LiveFlight = {
	scope: ExecutionScope;
	waiters: number;
	streaming: boolean;
	owner: Promise<ApolloHttpGraphQLResponse>;
	shared: Promise<CompleteApolloResponse | null>;
};
const liveMatchdayExecutionFlights = new Map<string, LiveFlight>();

type LiveMatchdayExecutionTransport = Readonly<{
	method: string;
	accept: string;
	contentType: string;
	apolloRequirePreflight: string;
	apolloOperationName: string;
}>;

/**
 * Build a process-local key for one public liveMatchday operation. The body is
 * hashed so query text and variables never enter state or telemetry, while the
 * season and deploy SHA fence the flight to one exact runtime/data scope.
 */
export const liveMatchdayExecutionFlightKey = (
	parsedBody: unknown,
	season: string,
	transport: LiveMatchdayExecutionTransport
): string | null => {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify({
			transport: {
				method: transport.method.toUpperCase(),
				accept: transport.accept,
				contentType: transport.contentType,
				apolloRequirePreflight: transport.apolloRequirePreflight,
				apolloOperationName: transport.apolloOperationName,
			},
			parsedBody,
		});
	} catch {
		return null;
	}
	if (serialized === undefined) return null;
	const bodyHash = createHash("sha256").update(serialized, "utf8").digest("hex");
	return `live-matchday:${env.DEPLOY_SHA}:${season}:${bodyHash}`;
};

const materializeCompleteResponse = (
	response: ApolloHttpGraphQLResponse,
	observation: LiveMatchExecutionObservation | null
): CompleteApolloResponse | null => {
	if (response.body.kind !== "complete" || observation === null) return null;
	return {
		status: response.status ?? 200,
		headers: [...response.headers.entries()],
		body: response.body.string,
		observation,
	};
};

const materializeCompleteResponseSafely = (
	response: ApolloHttpGraphQLResponse,
	getObservation: () => LiveMatchExecutionObservation | null
): CompleteApolloResponse | null => {
	try {
		return materializeCompleteResponse(response, getObservation());
	} catch {
		return null;
	}
};

const restoreCompleteResponse = (response: CompleteApolloResponse): ApolloHttpGraphQLResponse => {
	const headers = new HeaderMap();
	for (const [name, value] of response.headers) headers.set(name, value);
	return {
		status: response.status,
		headers,
		body: { kind: "complete", string: response.body },
	};
};

const isLiveMatchdayResponseShareable = (response: CompleteApolloResponse): boolean =>
	response.observation.shareUntilMs === null || Date.now() < response.observation.shareUntilMs;

/**
 * Coalesce only overlapping complete executions. This is intentionally not a
 * completed-result cache: once the owner settles, a later request performs a
 * fresh Redis/revision read. Non-complete or rejected executions are never
 * shared, preserving Apollo's normal streaming/error behavior.
 */
const executeLiveMatchdayFlight = async (
	key: string,
	execute: (context: GraphQLContext) => Promise<ApolloHttpGraphQLResponse>,
	context: GraphQLContext,
	getObservation: (context: GraphQLContext) => LiveMatchExecutionObservation | null
): Promise<ApolloHttpGraphQLResponse> => {
	const caller = context.executionScope ?? ExecutionScope.current();
	caller?.remainingMs();
	let flight = liveMatchdayExecutionFlights.get(key);
	if (flight && (flight.scope.signal.aborted || Date.now() >= flight.scope.deadlineAt)) {
		liveMatchdayExecutionFlights.delete(key);
		flight = undefined;
	}
	const ownsFlight = !flight;
	if (!flight) {
		const scope = new ExecutionScope(caller?.deadlineAt);
		const database = createDatabaseExecutor(scope);
		const ownerContext: GraphQLContext = {
			...context,
			executionScope: scope,
			database,
			data: new ReadModelClient(database, context.currentSeason),
			requestScope: {},
		};
		const owner = scope.run(() => scope.wait(execute(ownerContext)));
		const created: LiveFlight = {
			scope,
			waiters: 0,
			streaming: false,
			owner,
			shared: undefined as unknown as Promise<CompleteApolloResponse | null>,
		};
		created.shared = owner
			.then(
				(response) => {
					scope.remainingMs();
					return materializeCompleteResponseSafely(response, () => getObservation(ownerContext));
				},
				() => null
			)
			.finally(() => {
				if (liveMatchdayExecutionFlights.get(key) === created)
					liveMatchdayExecutionFlights.delete(key);
			});
		flight = created;
		liveMatchdayExecutionFlights.set(key, flight);
	}
	flight.waiters++;
	try {
		const shared = await (caller ? caller.wait(flight.shared) : flight.shared);
		if (shared && (ownsFlight || isLiveMatchdayResponseShareable(shared))) {
			if (!ownsFlight) {
				metrics.liveMatchExecutionCoalescedTotal.inc();
				metrics.liveMatchDeliveryTotal
					.labels(shared.observation.view, shared.observation.state, shared.observation.servedFrom)
					.inc();
			}
			return restoreCompleteResponse(shared);
		}
		if (!ownsFlight) {
			caller?.remainingMs();
			return execute(context);
		}
		const response = await flight.owner;
		if (response.body.kind !== "complete") {
			flight.streaming = true;
			const scope = flight.scope;
			const source = response.body.asyncIterator;
			const abort = (): void => scope.cancel();
			caller?.signal.addEventListener("abort", abort, { once: true });
			response.body.asyncIterator = (async function* () {
				try {
					while (true) {
						const item = await scope.wait(scope.run(() => source.next()));
						if (item.done) return;
						yield item.value;
					}
				} finally {
					caller?.signal.removeEventListener("abort", abort);
					scope.dispose();
					await source.return?.();
				}
			})();
		}
		return response;
	} finally {
		if (--flight.waiters === 0 && !flight.streaming) flight.scope.dispose();
	}
};

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
	responseFlightKey,
	responseFlightObservation,
}: {
	apollo: ApolloServer<GraphQLContext>;
	request: Request;
	parsedBody: unknown;
	context: GraphQLContext;
	requestTiming: RequestTiming;
	requestId: string;
	corsHeaders: Record<string, string>;
	/** Only set for the public, single-root liveMatchday operation. */
	responseFlightKey?: string;
	/** Owner-only publication metadata used to guard and observe restored results. */
	responseFlightObservation?: (context: GraphQLContext) => LiveMatchExecutionObservation | null;
}): Promise<GraphQLExecutionResult> => {
	const headers = new HeaderMap();
	request.headers.forEach((value, key) => {
		headers.set(key, value);
	});

	const execute = (
		executionContext: GraphQLContext = context
	): Promise<ApolloHttpGraphQLResponse> =>
		apollo.executeHTTPGraphQLRequest({
			httpGraphQLRequest: {
				method: request.method.toUpperCase(),
				headers,
				body: parsedBody,
				search: "",
			},
			context: async () => executionContext,
		});
	const httpGraphQLResponse = await requestTiming.measure("apollo", () =>
		responseFlightKey && responseFlightObservation
			? executeLiveMatchdayFlight(responseFlightKey, execute, context, responseFlightObservation)
			: execute()
	);

	context.executionScope?.remainingMs();
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
			async cancel(): Promise<void> {
				context.executionScope?.cancel();
				await asyncIterator.return?.();
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
