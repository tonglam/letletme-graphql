import { ApolloServer, HeaderMap } from '@apollo/server';
import type { GraphQLContext } from './graphql/context';
import { schema } from './graphql/schema';
import { env } from './infra/env';
import { logger } from './infra/logger';
import { metrics, metricsResponse } from './infra/metrics';
import { connectRedis, getRedis } from './infra/redis';
import { supabase } from './infra/supabase';

const startServer = async (): Promise<void> => {
  await connectRedis();

  const apollo = new ApolloServer<GraphQLContext>({
    schema,
  });

  await apollo.start();

  Bun.serve({
    port: env.PORT,
    fetch: async (request: Request) => {
      const url = new URL(request.url);

      if (url.pathname === '/health') {
        return new Response('ok');
      }

      if (url.pathname === '/metrics') {
        return metricsResponse();
      }

      if (url.pathname === '/graphql') {
        const start = performance.now();

        // Parse GraphQL request
        const body = await request.text();
        const headers = new HeaderMap();
        request.headers.forEach((value, key) => {
          headers.set(key, value);
        });

        const httpGraphQLResponse = await apollo.executeHTTPGraphQLRequest({
          httpGraphQLRequest: {
            method: request.method.toUpperCase(),
            headers,
            body: body ? JSON.parse(body) : undefined,
            search: url.search,
          },
          context: async () => ({
            supabase,
            redis: getRedis(),
            logger,
          }),
        });

        const durationMs = performance.now() - start;

        // Build response
        const responseHeaders: Record<string, string> = {};
        for (const [key, value] of httpGraphQLResponse.headers) {
          responseHeaders[key] = value;
        }

        // Handle both string and chunked response bodies
        let responseBody: string | ReadableStream;
        if (httpGraphQLResponse.body.kind === 'complete') {
          responseBody = httpGraphQLResponse.body.string;
        } else {
          // For chunked responses, create a ReadableStream
          const { asyncIterator } = httpGraphQLResponse.body;
          responseBody = new ReadableStream({
            async start(controller): Promise<void> {
              for await (const chunk of asyncIterator) {
                controller.enqueue(new TextEncoder().encode(chunk));
              }
              controller.close();
            },
          });
        }

        const response = new Response(responseBody, {
          status: httpGraphQLResponse.status || 200,
          headers: responseHeaders,
        });

        metrics.httpRequestDurationSeconds
          .labels(request.method, url.pathname, String(response.status))
          .observe(durationMs / 1000);

        logger.info(
          {
            method: request.method,
            path: url.pathname,
            status: response.status,
            durationMs: Number(durationMs.toFixed(2)),
          },
          'request'
        );

        return response;
      }

      return new Response('Not Found', { status: 404 });
    },
  });

  logger.info({ port: env.PORT }, 'Apollo Server started');
  logger.info({ url: `http://localhost:${env.PORT}/graphql` }, 'GraphQL endpoint ready');
};

startServer().catch((error: unknown) => {
  logger.error({ err: error }, 'Failed to start server');
  process.exit(1);
});
