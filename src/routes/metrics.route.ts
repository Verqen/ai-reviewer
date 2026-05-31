import type { FastifyInstance } from "fastify";
import { prometheusContentType, type Registry } from "prom-client";

interface MetricsRouteOptions {
  registry: Registry;
}

function metricsRoute(
  app: FastifyInstance,
  { registry }: MetricsRouteOptions
): void {
  app.get("/metrics", async (_req, reply) => {
    const body = await registry.metrics();
    return reply
      .status(200)
      .header("Content-Type", prometheusContentType)
      .send(body);
  });
}

export { metricsRoute };
export type { MetricsRouteOptions };
