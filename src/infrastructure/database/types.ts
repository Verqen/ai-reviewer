import type { Generated, Insertable, Selectable, Updateable } from "kysely";

type ReviewStatus = "queued" | "in_progress" | "completed" | "failed";

type Severity = "critical" | "attention" | "warning" | "info" | "nitpick";

type FindingCategory = string;

type CommentResolution = "pending" | "addressed" | "dismissed" | "wont_fix";

type TriggerType =
  | "mr_open"
  | "mr_undraft"
  | "push"
  | "force_push"
  | "rebase"
  | "main_push"
  | "mention";

type LineType = "added" | "removed" | "context";

interface ReviewRunTable {
  base_commit_sha: string;
  completed_at: Date | null;
  completion_tokens: number | null;
  config_snapshot: unknown;
  critical_count: number | null;
  error_message: string | null;
  files_reviewed: number | null;
  head_commit_sha: string;
  id: Generated<string>;
  is_incremental: boolean;
  mr_iid: number;
  previous_run_id: string | null;
  project_id: number;
  prompt_tokens: number | null;
  queued_at: Generated<Date>;
  review_model: string | null;
  started_at: Date | null;
  status: ReviewStatus;
  total_cost: number | null;
  total_findings: number | null;
  triage_model: string | null;
  trigger_type: TriggerType;
  warning_count: number | null;
}

interface ReviewFindingTable {
  category: FindingCategory;
  comment: string;
  confidence: number;
  dismiss_reason: string | null;
  end_line_number: number | null;
  file_path: string;
  host_discussion_id: string | null;
  host_note_id: string | null;
  hunk_header: string | null;
  id: Generated<string>;
  line_excerpt: string | null;
  line_number: number;
  line_type: LineType;
  model: string;
  old_path: string | null;
  original_snippet: string | null;
  pass_name: string;
  resolution: Generated<CommentResolution>;
  resolved_at: Date | null;
  resolved_by: string | null;
  review_run_id: string;
  severity: Severity;
  suggestion: string | null;
}

type BaselineStatus = "missing" | "bootstrapping" | "ready" | "failed";

interface SnapshotBlobTable {
  content: Buffer;
  created_at: Generated<Date>;
  hash: string;
}

interface SnapshotCommitTable {
  commit_sha: string;
  created_at: Generated<Date>;
  file_count: number;
  project_id: number;
}

interface SnapshotEntryTable {
  blob_hash: string;
  commit_sha: string;
  file_path: string;
  project_id: number;
}

interface BaselineStateTable {
  commit_sha: string;
  error_message: string | null;
  project_id: number;
  status: BaselineStatus;
  updated_at: Generated<Date>;
}

interface DismissedPatternTable {
  category: FindingCategory;
  created_at: Generated<Date>;
  created_by: string | null;
  file_path_glob: string | null;
  id: Generated<string>;
  occurrence_count: Generated<number>;
  pattern_description: string;
  project_id: number;
  sample_comment: string | null;
  sample_reply: string | null;
  severity: Severity;
  updated_at: Generated<Date>;
}

interface Database {
  baseline_state: BaselineStateTable;
  dismissed_pattern: DismissedPatternTable;
  review_finding: ReviewFindingTable;
  review_run: ReviewRunTable;
  snapshot_blob: SnapshotBlobTable;
  snapshot_commit: SnapshotCommitTable;
  snapshot_entry: SnapshotEntryTable;
}

type ReviewRunRow = Selectable<ReviewRunTable>;
type NewReviewRun = Insertable<ReviewRunTable>;
type ReviewRunUpdate = Updateable<ReviewRunTable>;

type ReviewFindingRow = Selectable<ReviewFindingTable>;
type NewReviewFinding = Insertable<ReviewFindingTable>;
type ReviewFindingUpdate = Updateable<ReviewFindingTable>;

type DismissedPatternRow = Selectable<DismissedPatternTable>;
type NewDismissedPattern = Insertable<DismissedPatternTable>;

type SnapshotBlobRow = Selectable<SnapshotBlobTable>;
type SnapshotCommitRow = Selectable<SnapshotCommitTable>;
type SnapshotEntryRow = Selectable<SnapshotEntryTable>;
type BaselineStateRow = Selectable<BaselineStateTable>;

export type {
  BaselineStateRow,
  Database,
  DismissedPatternRow,
  NewDismissedPattern,
  NewReviewFinding,
  NewReviewRun,
  ReviewFindingRow,
  ReviewFindingUpdate,
  ReviewRunRow,
  ReviewRunUpdate,
  SnapshotBlobRow,
  SnapshotCommitRow,
  SnapshotEntryRow,
};
