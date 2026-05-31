/**
 * Public API of `@gkosach/core` — the consumable, side-effect-free engine surface.
 *
 * Importing this module does NOT start the HTTP server. The runnable webhook
 * server lives in `~/index` and is exposed via the `./server` subpath export;
 * import that only from a process entry point, never from library consumers.
 */

// Domain types
export type * from "~/domain/types/review.types";
export type * from "~/domain/types/pipeline.types";
export type * from "~/domain/types/code-host.types";
export type * from "~/domain/types/diff.types";
export type * from "~/domain/types/llm.types";

// Ports (hexagonal boundaries)
export type { ICodeHost } from "~/domain/ports/code-host.port";
export type { ILlmClient } from "~/domain/ports/llm.port";
export type { IOverlayView } from "~/domain/ports/overlay-view.port";

// Pipeline
export { PipelineOrchestrator } from "~/pipeline/pipeline.orchestrator";
export { TriagePass, applyTriageFilter } from "~/pipeline/passes/triage.pass";
export { FileReviewPass } from "~/pipeline/passes/file-review.pass";
export { CrossFilePass } from "~/pipeline/passes/cross-file.pass";
export { AggregationPass } from "~/pipeline/passes/aggregation.pass";
export { getPrimarySkipReason } from "~/pipeline/passes/skip-filter";

// Review utilities
export { parseDiff } from "~/review/diff-parser";
export { buildPosition } from "~/review/finding-inline-position";
export { formatCommentWithSuggestion } from "~/pipeline/prompts/suggestion-formatter";
export { buildSummaryNote } from "~/pipeline/prompts/summary.prompt";

// LLM providers
export { OpenRouterClient } from "~/infrastructure/llm/openrouter/openrouter.client";
export { OllamaClient } from "~/infrastructure/llm/ollama/ollama.client";

// Code-host adapters
export {
  GitLabCodeHost,
  GitLabNotFoundError,
} from "~/infrastructure/code-host/gitlab/gitlab.code-host";

// Configuration
export { AppConfig } from "~/config/app.config";
export { LlmConfig } from "~/config/llm.config";
export { OpenRouterConfig } from "~/config/openrouter.config";
export { GitLabConfig } from "~/config/gitlab.config";
export { PipelineConfig } from "~/config/pipeline.config";

// Application wiring
export { Application } from "~/application";
export { buildDiContainer } from "~/di/index";
