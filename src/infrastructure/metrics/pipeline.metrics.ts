import { Counter, Gauge, Histogram, type Registry } from "prom-client";

import { computeCostUsd } from "~/config/llm-pricing";
import type { SkipCategory } from "~/pipeline/passes/skip-filter";

type ReviewPhase = "cross-file" | "file-review" | "triage";

type RunStatus = "completed" | "failed" | "skipped";

type SkipReason = SkipCategory;

type TriageParseOutcome =
  | "json_merged"
  | "json_strict"
  | "parse_failed"
  | "prose_fallback";

interface LlmCallObservation {
  cachedInputTokens?: number;
  inputTokens: number;
  model: string;
  outputTokens: number;
  phase: ReviewPhase;
}

interface RunCompletionObservation {
  durationMs: number;
  status: RunStatus;
  triggerType: string;
}

class PipelineMetrics {
  private readonly cacheHitRate: Gauge<string>;
  private readonly costUsd: Counter<string>;
  private readonly filesSkipped: Counter<string>;
  private readonly runDuration: Histogram<string>;
  private readonly runsTotal: Counter<string>;
  private readonly tokensCached: Counter<string>;
  private readonly tokensInput: Counter<string>;
  private readonly tokensOutput: Counter<string>;
  private readonly triageParseOutcomes: Counter<string>;
  private readonly triageSkipRate: Gauge<string>;
  private readonly triageTrivial: Counter<string>;

  constructor(registry: Registry) {
    const registers = [registry];

    this.tokensInput = new Counter({
      help: "Total prompt tokens sent to the LLM (includes cached portion)",
      labelNames: ["model", "phase"] as const,
      name: "ai_reviewer_tokens_input_total",
      registers,
    });

    this.tokensCached = new Counter({
      help: "Prompt tokens served from the provider prompt cache",
      labelNames: ["model"] as const,
      name: "ai_reviewer_tokens_cached_total",
      registers,
    });

    this.tokensOutput = new Counter({
      help: "Total completion tokens produced by the LLM",
      labelNames: ["model", "phase"] as const,
      name: "ai_reviewer_tokens_output_total",
      registers,
    });

    this.costUsd = new Counter({
      help: "Estimated LLM spend in USD (derived from per-model pricing table)",
      labelNames: ["model"] as const,
      name: "ai_reviewer_cost_usd_total",
      registers,
    });

    this.filesSkipped = new Counter({
      help: "Files removed by the pre-LLM skip-filter, labelled by primary rule category",
      labelNames: ["reason"] as const,
      name: "ai_reviewer_files_skipped_total",
      registers,
    });

    this.triageTrivial = new Counter({
      help: "Hunks classified as trivial by the triage pass and excluded from review",
      labelNames: [] as const,
      name: "ai_reviewer_triage_trivial_total",
      registers,
    });

    this.triageSkipRate = new Gauge({
      help: "Share of hunks classified as trivial by the triage pass on the latest run (0..1)",
      labelNames: [] as const,
      name: "ai_reviewer_triage_skip_rate",
      registers,
    });

    this.cacheHitRate = new Gauge({
      help: "Share of prompt tokens served from cache on the latest call (0..1)",
      labelNames: ["model"] as const,
      name: "ai_reviewer_cache_hit_rate",
      registers,
    });

    this.runDuration = new Histogram({
      buckets: [
        1_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000,
      ],
      help: "End-to-end wall-clock duration of a review run, in milliseconds",
      labelNames: ["status"] as const,
      name: "ai_reviewer_review_duration_ms",
      registers,
    });

    this.runsTotal = new Counter({
      help: "Total review runs by terminal status and trigger type",
      labelNames: ["status", "trigger_type"] as const,
      name: "ai_reviewer_runs_total",
      registers,
    });

    this.triageParseOutcomes = new Counter({
      help: "Triage batch parse outcomes — track model drift between strict JSON, merged-key fallback, prose fallback, and total failure",
      labelNames: ["model", "outcome"] as const,
      name: "ai_reviewer_triage_parse_outcomes_total",
      registers,
    });
  }

  observeLlmCall(call: LlmCallObservation): void {
    const cachedInput = call.cachedInputTokens ?? 0;
    const inputTokens = Math.max(0, call.inputTokens);
    const safeCachedInput = Math.min(cachedInput, inputTokens);
    const outputTokens = Math.max(0, call.outputTokens);

    this.tokensInput.inc({ model: call.model, phase: call.phase }, inputTokens);
    this.tokensOutput.inc(
      { model: call.model, phase: call.phase },
      outputTokens,
    );
    if (safeCachedInput > 0) {
      this.tokensCached.inc({ model: call.model }, safeCachedInput);
    }

    if (inputTokens > 0) {
      this.cacheHitRate.set(
        { model: call.model },
        safeCachedInput / inputTokens,
      );
    }

    const cost = computeCostUsd(call.model, {
      cachedInputTokens: safeCachedInput,
      inputTokens,
      outputTokens,
    });
    if (cost > 0) {
      this.costUsd.inc({ model: call.model }, cost);
    }
  }

  observeFileSkipped(reason: SkipReason): void {
    this.filesSkipped.inc({ reason });
  }

  observeTriageTrivial(count: number): void {
    if (count <= 0) {
      return;
    }
    this.triageTrivial.inc(count);
  }

  observeTriageSkipRate(skipRate: number): void {
    const bounded = Math.min(1, Math.max(0, skipRate));
    this.triageSkipRate.set(bounded);
  }

  observeRunCompletion(run: RunCompletionObservation): void {
    this.runDuration.observe({ status: run.status }, run.durationMs);
    this.runsTotal.inc({ status: run.status, trigger_type: run.triggerType });
  }

  observeTriageParseOutcome(model: string, outcome: TriageParseOutcome): void {
    this.triageParseOutcomes.inc({ model, outcome });
  }
}

export { PipelineMetrics };
export type {
  LlmCallObservation,
  ReviewPhase,
  RunCompletionObservation,
  RunStatus,
  SkipReason,
  TriageParseOutcome,
};
