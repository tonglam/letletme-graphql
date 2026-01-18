import { ApolloServer, HeaderMap } from '@apollo/server';
import type { GraphQLContext } from './graphql/context';
import { schema } from './graphql/schema';
import { auth, getUserFromSession } from './infra/auth';
import { authenticateDevice, validateDeviceToken } from './infra/device-auth';
import { env } from './infra/env';
import { logger } from './infra/logger';
import { metrics, metricsResponse } from './infra/metrics';
import { connectRedis, getRedis } from './infra/redis';
import { supabase } from './infra/supabase';

// CORS helper function
function getCorsHeaders(origin: string | null): Record<string, string> {
  const allowedOrigin = env.CORS_ORIGIN === '*' 
    ? (origin || '*')
    : env.CORS_ORIGIN;

  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400', // 24 hours
  };

  if (env.CORS_CREDENTIALS) {
    headers['Access-Control-Allow-Credentials'] = 'true';
  }

  return headers;
}

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
      const origin = request.headers.get('Origin');
      const corsHeaders = getCorsHeaders(origin);

      // Handle CORS preflight requests
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: corsHeaders,
        });
      }

      // Health check
      if (url.pathname === '/health') {
        return new Response('ok', {
          headers: corsHeaders,
        });
      }

      // Prometheus metrics
      if (url.pathname === '/metrics') {
        return metricsResponse();
      }

      // Better Auth endpoints (OAuth + email/password for web)
      if (url.pathname.startsWith('/api/auth')) {
        return auth.handler(request);
      }

      // Device authentication endpoint (for mobile)
      if (url.pathname === '/api/device/auth' && request.method === 'POST') {
        try {
          const body = (await request.json()) as {
            device_id?: string;
            device_name?: string;
            device_os?: string;
          };
          const { device_id, device_name, device_os } = body;

          if (!device_id || typeof device_id !== 'string') {
            return new Response(
              JSON.stringify({ error: 'device_id is required and must be a string' }),
              {
                status: 400,
                headers: {
                  'Content-Type': 'application/json',
                  ...corsHeaders,
                },
              }
            );
          }

          const result = await authenticateDevice(device_id, {
            name: device_name,
            os: device_os,
          });

          return new Response(JSON.stringify(result), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders,
            },
          });
        } catch (error) {
          logger.error({ err: error }, 'Device authentication failed');
          return new Response(
            JSON.stringify({ error: 'Authentication failed' }),
            {
              status: 500,
              headers: {
                'Content-Type': 'application/json',
                ...corsHeaders,
              },
            }
          );
        }
      }

      // GraphQL endpoint
      if (url.pathname === '/graphql') {
        const start = performance.now();

        // Parse GraphQL request
        const body = await request.text();
        const headers = new HeaderMap();
        request.headers.forEach((value, key) => {
          headers.set(key, value);
        });

        // Authenticate user (web session or mobile device token)
        let user = await getUserFromSession(request.headers);

        // If no web session, try mobile device token
        if (!user) {
          const authHeader = request.headers.get('Authorization');
          const token = authHeader?.replace('Bearer ', '').trim();

          if (token) {
            user = await validateDeviceToken(token);
          }
        }

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
            user: user ?? undefined, // Convert null to undefined for GraphQLContext
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

        // Merge CORS headers with GraphQL response headers
        const finalHeaders = {
          ...responseHeaders,
          ...corsHeaders,
        };

        const response = new Response(responseBody, {
          status: httpGraphQLResponse.status || 200,
          headers: finalHeaders,
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

      return new Response('Not Found', {
        status: 404,
        headers: corsHeaders,
      });
    },
  });

  logger.info({ port: env.PORT }, 'Apollo Server started');
  logger.info({ url: `http://localhost:${env.PORT}/graphql` }, 'GraphQL endpoint ready');
};

startServer().catch((error: unknown) => {
  logger.error({ err: error }, 'Failed to start server');
  process.exit(1);
});
