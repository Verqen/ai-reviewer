import Fastify from "fastify";
import { prometheusContentType, Registry } from "prom-client";
import { describe, expect, it } from "vitest";

import { PipelineMetrics } from "~/infrastructure/metrics/pipeline.metrics";

import { metricsRoute } from "./metrics.route";

describe("metricsRoute", () => {
  it("exposes the registry snapshot with the prometheus content type", async () => {
    const registry = new Registry();
    const metrics = new PipelineMetrics(registry);
    metrics.observeFileSkipped("lock");
    metrics.observeFileSkipped("lock");
    metrics.observeFileSkipped("lock");

    const app = Fastify({ logger: false });
    await app.register(metricsRoute, { registry });

    const response = await app.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe(prometheusContentType);
    expect(response.body).toMatch(
      /ai_reviewer_files_skipped_total\{reason="lock"\} 3/
    );

    await app.close();
  });

  it("serves metrics even before any observation has been recorded", async () => {
    const registry = new Registry();
    new PipelineMetrics(registry);

    const app = Fastify({ logger: false });
    await app.register(metricsRoute, { registry });

    const response = await app.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("ai_reviewer_files_skipped_total");

    await app.close();
  });
});
