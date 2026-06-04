import type { IOverlayView } from "~/domain/ports/overlay-view.port";
import type { CostBudget } from "~/pipeline/cost-budget";
import type {
  MergeRequestInfo,
  VersionInfo,
} from "~/domain/types/code-host.types";
import type { ReviewPipelineConfig } from "~/domain/types/config.types";
import type { ParsedFileDiff } from "~/domain/types/diff.types";
import type { ForcePushCorrelationResult } from "~/domain/types/force-push-correlation.types";
import type { Finding, PriorFindingsByFile } from "~/domain/types/review.types";

interface ReviewContext {
  architectureSnapshot?: string | undefined;
  costBudget?: CostBudget | undefined;
  diffs: ParsedFileDiff[];
  forcePushCorrelation?: ForcePushCorrelationResult | undefined;
  isIncremental: boolean;
  mrIid: number;
  mrInfo: MergeRequestInfo;
  overlayView?: IOverlayView | undefined;
  previousFindings: Finding[];
  priorFindingsByFile?: PriorFindingsByFile | undefined;
  projectId: number;
  reviewConfig: ReviewPipelineConfig;
  reviewRunId: string;
  toolCallCache: Map<string, Promise<string>>;
  versions: VersionInfo;
}

interface PassResult<M = unknown> {
  findings: Finding[];
  metadata: M;
  tokenUsage: { completionTokens: number; promptTokens: number };
  tokenUsageByModel?: Record<
    string,
    { completionTokens: number; promptTokens: number }
  >;
}

interface IReviewPass<M = unknown> {
  execute(
    context: ReviewContext,
    priorResults: Map<string, PassResult>,
  ): Promise<PassResult<M>>;
  readonly name: string;
}

interface AggregationResult {
  allFindings: Finding[];
  postableFindings: Finding[];
  repostedFindings: Finding[];
  suppressedCount: number;
}

export type { AggregationResult, IReviewPass, PassResult, ReviewContext };
