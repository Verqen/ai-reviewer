type Severity = "critical" | "attention" | "warning" | "info" | "nitpick";

type FindingCategory = string;

type ReviewStatus = "queued" | "in_progress" | "completed" | "failed";

type CommentResolution = "pending" | "addressed" | "dismissed" | "wont_fix";

type TriggerType =
  | "mr_open"
  | "mr_undraft"
  | "push"
  | "force_push"
  | "rebase"
  | "main_push"
  | "mention";

type IncrementalTriggerType = Extract<
  TriggerType,
  "force_push" | "push" | "rebase"
>;

type ForcePushLikeTriggerType = Exclude<IncrementalTriggerType, "push">;

function isForcePushLikeTriggerType(
  triggerType: TriggerType
): triggerType is ForcePushLikeTriggerType {
  return triggerType === "force_push" || triggerType === "rebase";
}

interface CommentContext {
  discussionId?: string | null | undefined;
  newLine?: number | null | undefined;
  newPath?: string | undefined;
  note: string;
  oldLine?: number | null | undefined;
  oldPath?: string | undefined;
}

type LineType = "added" | "removed" | "context";

interface Finding {
  category: FindingCategory;
  comment: string;
  confidence: number;
  endLineNumber?: number | undefined;
  filePath: string;
  hunkHeader?: string | undefined;
  lineExcerpt?: string | undefined;
  lineNumber: number;
  lineType: LineType;
  model: string;
  oldPath?: string | undefined;
  originalSnippet?: string | undefined;
  passName: string;
  severity: Severity;
  suggestion?: string | undefined;
}

interface ReviewRun {
  baseCommitSha: string;
  completedAt?: Date | undefined;
  completionTokens?: number | undefined;
  configSnapshot?: Record<string, unknown> | undefined;
  criticalCount?: number | undefined;
  errorMessage?: string | undefined;
  filesReviewed?: number | undefined;
  headCommitSha: string;
  id: string;
  isIncremental: boolean;
  mrIid: number;
  previousRunId?: string | undefined;
  projectId: number;
  promptTokens?: number | undefined;
  queuedAt: Date;
  reviewModel?: string | undefined;
  startedAt?: Date | undefined;
  status: ReviewStatus;
  totalCost?: number | undefined;
  totalFindings?: number | undefined;
  triageModel?: string | undefined;
  triggerType: TriggerType;
  warningCount?: number | undefined;
}

interface ReviewFinding {
  category: FindingCategory;
  comment: string;
  confidence: number;
  dismissReason?: string | undefined;
  endLineNumber?: number | undefined;
  filePath: string;
  hostDiscussionId?: string | undefined;
  hostNoteId?: string | undefined;
  hunkHeader?: string | undefined;
  id: string;
  lineExcerpt?: string | undefined;
  lineNumber: number;
  lineType: LineType;
  model: string;
  oldPath?: string | undefined;
  originalSnippet?: string | undefined;
  passName: string;
  resolution: CommentResolution;
  resolvedAt?: Date | undefined;
  resolvedBy?: string | undefined;
  reviewRunId: string;
  severity: Severity;
  suggestion?: string | undefined;
}

interface PriorFindings {
  addressed: ReviewFinding[];
  dismissed: ReviewFinding[];
  pending: ReviewFinding[];
}

interface PriorFindingsByFile {
  addressed: Map<string, ReviewFinding[]>;
  dismissed: Map<string, ReviewFinding[]>;
  pending: Map<string, ReviewFinding[]>;
}

export { isForcePushLikeTriggerType };
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
};
