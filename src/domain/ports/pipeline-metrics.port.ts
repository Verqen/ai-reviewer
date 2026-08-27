import type { SkipCategory } from "~/domain/types/skip.types";

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

interface IPipelineMetrics {
  observeFileSkipped(reason: SkipReason): void;
  observeLlmCall(call: LlmCallObservation): void;
  observeRunCompletion(run: RunCompletionObservation): void;
  observeTriageParseOutcome(model: string, outcome: TriageParseOutcome): void;
  observeTriageSkipRate(skipRate: number): void;
  observeTriageTrivial(count: number): void;
}

export type {
  IPipelineMetrics,
  LlmCallObservation,
  ReviewPhase,
  RunCompletionObservation,
  RunStatus,
  SkipReason,
  TriageParseOutcome,
};
