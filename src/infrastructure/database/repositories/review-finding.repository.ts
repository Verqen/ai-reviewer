import type { Kysely } from "kysely";

import { InjectionTokens } from "~/di/injection-tokens";
import type {
  CreateReviewFindingInput,
  IReviewFindingRepository,
} from "~/domain/ports/review-finding.repository.port";
import type {
  CommentResolution,
  LineType,
  ReviewFinding,
  Severity,
} from "~/domain/types/review.types";
import type { Database } from "~/infrastructure/database/types";

function rowToReviewFinding(row: {
  id: string;
  review_run_id: string;
  file_path: string;
  old_path: string | null;
  line_number: number;
  line_type: string;
  line_excerpt: string | null;
  hunk_header: string | null;
  end_line_number: number | null;
  severity: string;
  category: string;
  comment: string;
  suggestion: string | null;
  original_snippet: string | null;
  confidence: number;
  host_discussion_id: string | null;
  host_note_id: string | null;
  resolution: string;
  resolved_at: Date | null;
  resolved_by: string | null;
  dismiss_reason: string | null;
  pass_name: string;
  model: string;
}): ReviewFinding {
  return {
    category: row.category,
    comment: row.comment,
    confidence: row.confidence,
    dismissReason: row.dismiss_reason ?? undefined,
    endLineNumber: row.end_line_number ?? undefined,
    filePath: row.file_path,
    hostDiscussionId: row.host_discussion_id ?? undefined,
    hostNoteId: row.host_note_id ?? undefined,
    hunkHeader: row.hunk_header ?? undefined,
    id: row.id,
    lineExcerpt: row.line_excerpt ?? undefined,
    lineNumber: row.line_number,
    lineType: row.line_type as LineType,
    model: row.model,
    oldPath: row.old_path ?? undefined,
    originalSnippet: row.original_snippet ?? undefined,
    passName: row.pass_name,
    resolution: row.resolution as CommentResolution,
    resolvedAt: row.resolved_at ?? undefined,
    resolvedBy: row.resolved_by ?? undefined,
    reviewRunId: row.review_run_id,
    severity: row.severity as Severity,
    suggestion: row.suggestion ?? undefined,
  };
}

class ReviewFindingRepository implements IReviewFindingRepository {
  static inject = [InjectionTokens.Database] as const;

  constructor(private readonly db: Kysely<Database>) {}

  async createMany(
    findings: CreateReviewFindingInput[],
  ): Promise<ReviewFinding[]> {
    if (findings.length === 0) {
      return [];
    }

    const rows = await this.db
      .insertInto("review_finding")
      .values(
        findings.map((f) => ({
          category: f.category,
          comment: f.comment,
          confidence: f.confidence,
          end_line_number: f.endLineNumber ?? null,
          file_path: f.filePath,
          host_discussion_id: f.hostDiscussionId ?? null,
          host_note_id: f.hostNoteId ?? null,
          hunk_header: f.hunkHeader ?? null,
          line_excerpt: f.lineExcerpt ?? null,
          line_number: f.lineNumber,
          line_type: f.lineType,
          model: f.model,
          old_path: f.oldPath ?? null,
          original_snippet: f.originalSnippet ?? null,
          pass_name: f.passName,
          review_run_id: f.reviewRunId,
          severity: f.severity,
          suggestion: f.suggestion ?? null,
        })),
      )
      .returningAll()
      .execute();

    return rows.map(rowToReviewFinding);
  }

  async findByRunId(reviewRunId: string): Promise<ReviewFinding[]> {
    const rows = await this.db
      .selectFrom("review_finding")
      .selectAll()
      .where("review_run_id", "=", reviewRunId)
      .execute();

    return rows.map(rowToReviewFinding);
  }

  async findByProjectAndMr(
    projectId: number,
    mrIid: number,
  ): Promise<ReviewFinding[]> {
    const rows = await this.db
      .selectFrom("review_finding")
      .innerJoin("review_run", "review_run.id", "review_finding.review_run_id")
      .selectAll("review_finding")
      .where("review_run.project_id", "=", projectId)
      .where("review_run.mr_iid", "=", mrIid)
      .execute();

    return rows.map(rowToReviewFinding);
  }

  async updateResolution(
    id: string,
    resolution: CommentResolution,
    resolvedBy?: string,
    dismissReason?: string,
  ): Promise<void> {
    await this.db
      .updateTable("review_finding")
      .set({
        dismiss_reason: dismissReason ?? null,
        resolution,
        resolved_at: new Date(),
        resolved_by: resolvedBy ?? null,
      })
      .where("id", "=", id)
      .execute();
  }

  async updateResolutionMany(
    ids: readonly string[],
    resolution: CommentResolution,
    resolvedBy?: string,
    dismissReason?: string,
  ): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.db
      .updateTable("review_finding")
      .set({
        dismiss_reason: dismissReason ?? null,
        resolution,
        resolved_at: new Date(),
        resolved_by: resolvedBy ?? null,
      })
      .where("id", "in", [...ids])
      .execute();
  }
}

export { ReviewFindingRepository };
