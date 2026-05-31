import type { Kysely } from "kysely";

import { InjectionTokens } from "~/di/injection-tokens";
import type {
  CreateReviewRunInput,
  FindLatestReviewRunOptions,
  IReviewRunRepository,
  UpdateReviewRunStatsInput,
} from "~/domain/ports/review-run.repository.port";
import type {
  ReviewRun,
  ReviewStatus,
  TriggerType,
} from "~/domain/types/review.types";
import type { Database } from "~/infrastructure/database/types";

function rowToReviewRun(row: {
  id: string;
  project_id: number;
  mr_iid: number;
  head_commit_sha: string;
  base_commit_sha: string;
  previous_run_id: string | null;
  status: string;
  is_incremental: boolean;
  trigger_type: string;
  queued_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  files_reviewed: number | null;
  total_findings: number | null;
  critical_count: number | null;
  warning_count: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_cost: number | null;
  triage_model: string | null;
  review_model: string | null;
  config_snapshot: unknown;
  error_message: string | null;
}): ReviewRun {
  return {
    baseCommitSha: row.base_commit_sha,
    completedAt: row.completed_at ?? undefined,
    completionTokens: row.completion_tokens ?? undefined,
    configSnapshot:
      row.config_snapshot != null
        ? (row.config_snapshot as Record<string, unknown>)
        : undefined,
    criticalCount: row.critical_count ?? undefined,
    errorMessage: row.error_message ?? undefined,
    filesReviewed: row.files_reviewed ?? undefined,
    headCommitSha: row.head_commit_sha,
    id: row.id,
    isIncremental: row.is_incremental,
    mrIid: row.mr_iid,
    previousRunId: row.previous_run_id ?? undefined,
    projectId: row.project_id,
    promptTokens: row.prompt_tokens ?? undefined,
    queuedAt: row.queued_at,
    reviewModel: row.review_model ?? undefined,
    startedAt: row.started_at ?? undefined,
    status: row.status as ReviewStatus,
    totalCost: row.total_cost ?? undefined,
    totalFindings: row.total_findings ?? undefined,
    triageModel: row.triage_model ?? undefined,
    triggerType: row.trigger_type as TriggerType,
    warningCount: row.warning_count ?? undefined,
  };
}

class ReviewRunRepository implements IReviewRunRepository {
  static inject = [InjectionTokens.Database] as const;

  constructor(private readonly db: Kysely<Database>) {}

  async deleteCompletedOrFailedBefore(now: Date): Promise<number> {
    return await this.db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom("review_finding")
        .where((eb) =>
          eb(
            "review_run_id",
            "in",
            eb
              .selectFrom("review_run")
              .select("id")
              .where("status", "in", ["completed", "failed"])
              .where("completed_at", "<", now)
          )
        )
        .execute();
      const deleteRunResult = await trx
        .deleteFrom("review_run")
        .where("status", "in", ["completed", "failed"])
        .where("completed_at", "<", now)
        .executeTakeFirst();
      return Number(deleteRunResult.numDeletedRows ?? 0n);
    });
  }

  async create(input: CreateReviewRunInput): Promise<ReviewRun> {
    const row = await this.db
      .insertInto("review_run")
      .values({
        base_commit_sha: input.baseCommitSha,
        head_commit_sha: input.headCommitSha,
        is_incremental: input.isIncremental,
        mr_iid: input.mrIid,
        previous_run_id: input.previousRunId ?? null,
        project_id: input.projectId,
        status: "queued",
        trigger_type: input.triggerType,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return rowToReviewRun(row);
  }

  async findById(id: string): Promise<ReviewRun | undefined> {
    const row = await this.db
      .selectFrom("review_run")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();

    return row ? rowToReviewRun(row) : undefined;
  }

  async findByProjectAndMr(
    projectId: number,
    mrIid: number
  ): Promise<ReviewRun[]> {
    const rows = await this.db
      .selectFrom("review_run")
      .selectAll()
      .where("project_id", "=", projectId)
      .where("mr_iid", "=", mrIid)
      .orderBy("queued_at", "desc")
      .execute();

    return rows.map(rowToReviewRun);
  }

  async findLatestByProjectAndMr(
    projectId: number,
    mrIid: number,
    triggerType?: TriggerType,
    options?: FindLatestReviewRunOptions
  ): Promise<ReviewRun | undefined> {
    const includeFailed = options?.includeFailedForBaseline === true;
    let query = this.db
      .selectFrom("review_run")
      .selectAll()
      .where("project_id", "=", projectId)
      .where("mr_iid", "=", mrIid);
    if (includeFailed) {
      query = query.where("status", "in", ["completed", "failed"]);
    } else {
      query = query.where("status", "=", "completed");
    }
    if (triggerType !== undefined) {
      query = query.where("trigger_type", "=", triggerType);
    }

    const row = await query
      .orderBy("completed_at", "desc")
      .limit(1)
      .executeTakeFirst();

    return row ? rowToReviewRun(row) : undefined;
  }

  async findByIdentity(
    projectId: number,
    mrIid: number,
    headCommitSha: string,
    baseCommitSha: string,
    triggerType: TriggerType
  ): Promise<ReviewRun | undefined> {
    const row = await this.db
      .selectFrom("review_run")
      .selectAll()
      .where("project_id", "=", projectId)
      .where("mr_iid", "=", mrIid)
      .where("head_commit_sha", "=", headCommitSha)
      .where("base_commit_sha", "=", baseCommitSha)
      .where("trigger_type", "=", triggerType)
      .executeTakeFirst();

    return row ? rowToReviewRun(row) : undefined;
  }

  async updateStatus(
    id: string,
    status: ReviewStatus,
    timestamp?: Date
  ): Promise<void> {
    const update: Record<string, Date | ReviewStatus> = { status };

    if (status === "in_progress" && timestamp) {
      update["started_at"] = timestamp;
    } else if ((status === "completed" || status === "failed") && timestamp) {
      update["completed_at"] = timestamp;
    }

    await this.db
      .updateTable("review_run")
      .set(update)
      .where("id", "=", id)
      .execute();
  }

  async updateStats(
    id: string,
    stats: UpdateReviewRunStatsInput
  ): Promise<void> {
    await this.db
      .updateTable("review_run")
      .set({
        completion_tokens: stats.completionTokens ?? null,
        config_snapshot: stats.configSnapshot ?? null,
        critical_count: stats.criticalCount ?? null,
        error_message: stats.errorMessage ?? null,
        files_reviewed: stats.filesReviewed ?? null,
        prompt_tokens: stats.promptTokens ?? null,
        review_model: stats.reviewModel ?? null,
        total_cost: stats.totalCost ?? null,
        total_findings: stats.totalFindings ?? null,
        triage_model: stats.triageModel ?? null,
        warning_count: stats.warningCount ?? null,
      })
      .where("id", "=", id)
      .execute();
  }

  async completeRun(
    id: string,
    params: {
      baseCommitSha: string;
      stats: UpdateReviewRunStatsInput;
      timestamp: Date;
    }
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable("review_run")
        .set({
          base_commit_sha: params.baseCommitSha,
          completed_at: params.timestamp,
          completion_tokens: params.stats.completionTokens ?? null,
          config_snapshot: params.stats.configSnapshot ?? null,
          critical_count: params.stats.criticalCount ?? null,
          error_message: params.stats.errorMessage ?? null,
          files_reviewed: params.stats.filesReviewed ?? null,
          prompt_tokens: params.stats.promptTokens ?? null,
          review_model: params.stats.reviewModel ?? null,
          status: "completed",
          total_cost: params.stats.totalCost ?? null,
          total_findings: params.stats.totalFindings ?? null,
          triage_model: params.stats.triageModel ?? null,
          warning_count: params.stats.warningCount ?? null,
        })
        .where("id", "=", id)
        .execute();
    });
  }
}

export { ReviewRunRepository };
