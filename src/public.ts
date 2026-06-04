export type {
  CommentContext,
  CommentResolution,
  Finding,
  FindingCategory,
  ForcePushLikeTriggerType,
  IncrementalTriggerType,
  LineType,
  PriorFindings,
  PriorFindingsByFile,
  ReviewFinding,
  ReviewRun,
  ReviewStatus,
  Severity,
  TriggerType,
} from "~/domain/types/review.types";
export { isForcePushLikeTriggerType } from "~/domain/types/review.types";
export type {
  AggregationResult,
  IReviewPass,
  PassResult,
  ReviewContext,
} from "~/domain/types/pipeline.types";
export type {
  ArchiveEntry,
  DiffFile,
  FileTreeEntry,
  InlinePosition,
  MergeRequestInfo,
  Note,
  VersionInfo,
  WebhookEvent,
} from "~/domain/types/code-host.types";
export { CodeHostNotFoundError } from "~/domain/types/code-host.types";
export type { DiffLine, ParsedFileDiff } from "~/domain/types/diff.types";
export type {
  CacheControl,
  ChatMessage,
  LlmOptions,
  LlmResponse,
  TextBlock,
  ToolCall,
  ToolDefinition,
} from "~/domain/types/llm.types";

export type { ICodeHost } from "~/domain/ports/code-host.port";
export type { ILlmClient } from "~/domain/ports/llm.port";
export type { IOverlayView } from "~/domain/ports/overlay-view.port";

export { PipelineOrchestrator } from "~/pipeline/pipeline.orchestrator";
export { TriagePass, applyTriageFilter } from "~/pipeline/passes/triage.pass";
export { FileReviewPass } from "~/pipeline/passes/file-review.pass";
export { CrossFilePass } from "~/pipeline/passes/cross-file.pass";
export { AggregationPass } from "~/pipeline/passes/aggregation.pass";
export { getPrimarySkipReason } from "~/pipeline/passes/skip-filter";

export { computeProductionReadinessScore } from "~/review/scoring.service";
export type {
  CategoryBreakdown,
  Grade,
  ProductionReadinessScore,
  ScoreCategory,
} from "~/review/scoring.service";
export {
  buildVibeCodingPatternsInstruction,
  escalateVibeCodingSeverity,
  VIBE_CODING_PATTERNS,
} from "~/pipeline/prompts/vibe-coding-patterns";

export {
  listGitHubInstallationRepositories,
  resolveGitHubPullRequestHead,
  reviewGitHubPullRequest,
} from "~/review/github-pr-review";
export type {
  GitHubPullRequestHead,
  GitHubPullRequestReviewOptions,
  GitHubPullRequestReviewResult,
  GitHubReviewPostMode,
  InstallationRepository,
  PriorThreadRef,
  ReviewedFinding,
  ReviewPathRule,
} from "~/review/github-pr-review";

export { answerReviewThread } from "~/review/github-thread-reply";
export type {
  AnswerReviewThreadOptions,
  AnswerReviewThreadResult,
  ReviewThreadFinding,
} from "~/review/github-thread-reply";

export { parseDiff } from "~/review/diff-parser";
export { buildPosition } from "~/review/finding-inline-position";
export { formatCommentWithSuggestion } from "~/pipeline/prompts/suggestion-formatter";
export { buildSummaryNote } from "~/pipeline/prompts/summary.prompt";

export { OpenRouterClient } from "~/infrastructure/llm/openrouter/openrouter.client";
export { OllamaClient } from "~/infrastructure/llm/ollama/ollama.client";

export {
  GitLabCodeHost,
  GitLabNotFoundError,
} from "~/infrastructure/code-host/gitlab/gitlab.code-host";

export { AppConfig } from "~/config/app.config";
export { LlmConfig } from "~/config/llm.config";
export { OpenRouterConfig } from "~/config/openrouter.config";
export { GitLabConfig } from "~/config/gitlab.config";
export { PipelineConfig } from "~/config/pipeline.config";

export { Application } from "~/application";
export { buildDiContainer } from "~/di/index";
