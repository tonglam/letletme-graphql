import { Registry, collectDefaultMetrics, Histogram } from 'prom-client';

const registry = new Registry();

collectDefaultMetrics({ register: registry });

const httpRequestDurationSeconds = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

registry.registerMetric(httpRequestDurationSeconds);

export const metrics = {
  registry,
  httpRequestDurationSeconds,
};

export const metricsResponse = async (): Promise<Response> => {
  const body = await registry.metrics();
  return new Response(body, {
    headers: {
      'Content-Type': registry.contentType,
    },
  });
};
