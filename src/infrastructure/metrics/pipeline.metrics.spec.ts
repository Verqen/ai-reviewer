import { Registry } from "prom-client";
import { beforeEach, describe, expect, it } from "vitest";

import { PipelineMetrics } from "./pipeline.metrics";

async function metricValue(
  registry: Registry,
  name: string,
  labels: Record<string, string> = {},
): Promise<number> {
  const metric = await registry.getSingleMetric(name)?.get();
  if (!metric) {
    throw new Error(`metric ${name} not found`);
  }
  const entry = metric.values.find((v) => {
    const vLabels = v.labels as Record<string, string>;
    const expectedEntries = Object.entries(labels);
    return expectedEntries.every(([key, value]) => vLabels[key] === value);
  });
  return entry?.value ?? 0;
}

describe("PipelineMetrics", () => {
  let registry: Registry;
  let metrics: PipelineMetrics;

  beforeEach(() => {
    registry = new Registry();
    metrics = new PipelineMetrics(registry);
  });

  describe("observeLlmCall", () => {
    it("increments input, output, and cached token counters", async () => {
      metrics.observeLlmCall({
        cachedInputTokens: 400,
        inputTokens: 1_000,
        model: "anthropic/claude-sonnet-4.6",
        outputTokens: 200,
        phase: "file-review",
      });

      expect(
        await metricValue(registry, "ai_reviewer_tokens_input_total", {
          model: "anthropic/claude-sonnet-4.6",
          phase: "file-review",
        }),
      ).toBe(1_000);
      expect(
        await metricValue(registry, "ai_reviewer_tokens_output_total", {
          model: "anthropic/claude-sonnet-4.6",
          phase: "file-review",
        }),
      ).toBe(200);
      expect(
        await metricValue(registry, "ai_reviewer_tokens_cached_total", {
          model: "anthropic/claude-sonnet-4.6",
        }),
      ).toBe(400);
    });

    it("sets cache_hit_rate as cached/input ratio", async () => {
      metrics.observeLlmCall({
        cachedInputTokens: 300,
        inputTokens: 1_000,
        model: "anthropic/claude-sonnet-4.6",
        outputTokens: 0,
        phase: "triage",
      });

      expect(
        await metricValue(registry, "ai_reviewer_cache_hit_rate", {
          model: "anthropic/claude-sonnet-4.6",
        }),
      ).toBeCloseTo(0.3);
    });

    it("does not create a cached counter when no cache is reported", async () => {
      metrics.observeLlmCall({
        inputTokens: 500,
        model: "anthropic/claude-sonnet-4.6",
        outputTokens: 100,
        phase: "triage",
      });

      expect(
        await metricValue(registry, "ai_reviewer_tokens_cached_total", {
          model: "anthropic/claude-sonnet-4.6",
        }),
      ).toBe(0);
    });

    it("accumulates cost in USD for models with known pricing", async () => {
      metrics.observeLlmCall({
        inputTokens: 1_000_000,
        model: "anthropic/claude-sonnet-4.6",
        outputTokens: 1_000_000,
        phase: "file-review",
      });

      expect(
        await metricValue(registry, "ai_reviewer_cost_usd_total", {
          model: "anthropic/claude-sonnet-4.6",
        }),
      ).toBeCloseTo(3 + 15);
    });

    it("skips cost accounting for unknown models", async () => {
      metrics.observeLlmCall({
        inputTokens: 1_000_000,
        model: "mystery-model",
        outputTokens: 1_000_000,
        phase: "triage",
      });

      expect(
        await metricValue(registry, "ai_reviewer_cost_usd_total", {
          model: "mystery-model",
        }),
      ).toBe(0);
    });

    it("clamps cachedTokens > inputTokens defensively", async () => {
      metrics.observeLlmCall({
        cachedInputTokens: 9_999,
        inputTokens: 100,
        model: "anthropic/claude-sonnet-4.6",
        outputTokens: 0,
        phase: "triage",
      });
      expect(
        await metricValue(registry, "ai_reviewer_tokens_cached_total", {
          model: "anthropic/claude-sonnet-4.6",
        }),
      ).toBe(100);
      expect(
        await metricValue(registry, "ai_reviewer_cache_hit_rate", {
          model: "anthropic/claude-sonnet-4.6",
        }),
      ).toBe(1);
    });
  });

  describe("observeFileSkipped", () => {
    it("increments files_skipped counter with reason label", async () => {
      metrics.observeFileSkipped("lock");
      metrics.observeFileSkipped("lock");
      metrics.observeFileSkipped("generated");
      expect(
        await metricValue(registry, "ai_reviewer_files_skipped_total", {
          reason: "lock",
        }),
      ).toBe(2);
      expect(
        await metricValue(registry, "ai_reviewer_files_skipped_total", {
          reason: "generated",
        }),
      ).toBe(1);
      expect(
        await metricValue(registry, "ai_reviewer_files_skipped_total", {
          reason: "binary",
        }),
      ).toBe(0);
    });
  });

  describe("observeTriageTrivial", () => {
    it("increments triage_trivial counter", async () => {
      metrics.observeTriageTrivial(6);
      metrics.observeTriageTrivial(2);
      expect(
        await metricValue(registry, "ai_reviewer_triage_trivial_total"),
      ).toBe(8);
    });

    it("is a no-op for zero or negative counts", async () => {
      metrics.observeTriageTrivial(0);
      metrics.observeTriageTrivial(-5);
      expect(
        await metricValue(registry, "ai_reviewer_triage_trivial_total"),
      ).toBe(0);
    });
  });

  describe("observeTriageSkipRate", () => {
    it("stores the rate as a gauge and clamps to [0, 1]", async () => {
      metrics.observeTriageSkipRate(0.42);
      expect(
        await metricValue(registry, "ai_reviewer_triage_skip_rate"),
      ).toBeCloseTo(0.42);

      metrics.observeTriageSkipRate(1.5);
      expect(await metricValue(registry, "ai_reviewer_triage_skip_rate")).toBe(
        1,
      );

      metrics.observeTriageSkipRate(-0.1);
      expect(await metricValue(registry, "ai_reviewer_triage_skip_rate")).toBe(
        0,
      );
    });
  });

  describe("observeRunCompletion", () => {
    it("records duration in the histogram and increments runs_total", async () => {
      metrics.observeRunCompletion({
        durationMs: 12_345,
        status: "completed",
        triggerType: "push",
      });
      metrics.observeRunCompletion({
        durationMs: 500,
        status: "failed",
        triggerType: "force_push",
      });

      expect(
        await metricValue(registry, "ai_reviewer_runs_total", {
          status: "completed",
          trigger_type: "push",
        }),
      ).toBe(1);
      expect(
        await metricValue(registry, "ai_reviewer_runs_total", {
          status: "failed",
          trigger_type: "force_push",
        }),
      ).toBe(1);

      const duration = registry.getSingleMetric(
        "ai_reviewer_review_duration_ms",
      );
      const snapshot = await duration?.get();
      expect(snapshot?.values.length ?? 0).toBeGreaterThan(0);
    });
  });

  describe("registry output", () => {
    it("exposes every metric in the registry output", async () => {
      metrics.observeFileSkipped("lock");
      metrics.observeTriageTrivial(2);
      metrics.observeTriageSkipRate(0.1);
      metrics.observeLlmCall({
        inputTokens: 100,
        model: "anthropic/claude-sonnet-4.6",
        outputTokens: 10,
        phase: "triage",
      });
      metrics.observeRunCompletion({
        durationMs: 100,
        status: "completed",
        triggerType: "push",
      });

      const output = await registry.metrics();
      expect(output).toContain("ai_reviewer_tokens_input_total");
      expect(output).toContain("ai_reviewer_tokens_output_total");
      expect(output).toContain("ai_reviewer_files_skipped_total");
      expect(output).toContain("ai_reviewer_triage_trivial_total");
      expect(output).toContain("ai_reviewer_triage_skip_rate");
      expect(output).toContain("ai_reviewer_review_duration_ms");
      expect(output).toContain("ai_reviewer_runs_total");
      expect(output).toContain("ai_reviewer_cost_usd_total");
    });
  });
});
