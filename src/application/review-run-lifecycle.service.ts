import type { FastifyBaseLogger } from "fastify";

import type { ReviewInfraRepoPorts } from "~/application/review.infra-repo-ports";
import type { PipelineConfig } from "~/config/pipeline.config";
import { InjectionTokens } from "~/di/injection-tokens";
import { ReviewTokens } from "~/di/review-tokens";
import type { VersionInfo } from "~/domain/types/code-host.types";
import type { ReviewRun, TriggerType } from "~/domain/types/review.types";

export type StartPipelineRunParams = {
  isIncremental: boolean;
  mrIid: number;
  previousRunId: string | undefined;
  projectId: number;
  triggerType: TriggerType;
  versions: VersionInfo;
};

export type StartPipelineRunResult =
  | {
      outcome: "skipped";
      reason:
        | "already_in_progress"
        | "completed_duplicate"
        | "unique_violation";
    }
  | { outcome: "started"; reviewRun: ReviewRun };

/**
 * Deduplication and `review_run` row lifecycle: create, in_progress, failed.
 */
class ReviewRunLifecycleService {
  static inject = [
    ReviewTokens.InfraRepoPorts,
    InjectionTokens.Logger,
    InjectionTokens.PipelineConfig,
  ] as const;

  constructor(
    private readonly infraRepoPorts: ReviewInfraRepoPorts,
    private readonly logger: FastifyBaseLogger,
    private readonly pipelineConfig: PipelineConfig
  ) {}

  async startRun(
    params: StartPipelineRunParams
  ): Promise<StartPipelineRunResult> {
    const {
      isIncremental,
      mrIid,
      previousRunId,
      projectId,
      triggerType,
      versions,
    } = params;
    if (triggerType !== "mention") {
      const existingRun =
        await this.infraRepoPorts.reviewRunRepo.findByIdentity(
          projectId,
          mrIid,
          versions.headSha,
          versions.baseSha,
          triggerType
        );
      if (existingRun?.status === "completed") {
        this.logger.info(
          { mrIid, projectId, runId: existingRun.id },
          "Skipping duplicate review (DB dedup)"
        );
        return { outcome: "skipped", reason: "completed_duplicate" };
      }
      if (existingRun?.status === "in_progress") {
        const stuckResult = await this.handleInProgressRun(
          existingRun,
          mrIid,
          projectId
        );
        if (stuckResult.outcome === "skipped") {
          return stuckResult;
        }
      }
    }
    let reviewRun: ReviewRun;
    try {
      reviewRun = await this.infraRepoPorts.reviewRunRepo.create({
        baseCommitSha: versions.baseSha,
        headCommitSha: versions.headSha,
        isIncremental,
        mrIid,
        previousRunId,
        projectId,
        triggerType,
      });
    } catch (err) {
      const isUniqueViolation =
        err instanceof Error &&
        "code" in err &&
        (err as { code: string }).code === "23505";
      if (isUniqueViolation) {
        this.logger.info(
          { mrIid, projectId },
          "Skipping duplicate review (unique constraint)"
        );
        return { outcome: "skipped", reason: "unique_violation" };
      }
      throw err;
    }
    await this.infraRepoPorts.reviewRunRepo.updateStatus(
      reviewRun.id,
      "in_progress",
      new Date()
    );
    return { outcome: "started", reviewRun };
  }

  /**
   * Decide whether an existing in_progress run is still alive or stale.
   *
   * - Alive (started/queued within `RUN_STUCK_AFTER_MS`): skip the new attempt
   *   so we don't pile up duplicate work.
   * - Stale (older): mark it failed (the previous pod likely crashed before
   *   reporting completion) and let the new attempt proceed.
   */
  private async handleInProgressRun(
    existingRun: ReviewRun,
    mrIid: number,
    projectId: number
  ): Promise<{ outcome: "proceeded" } | StartPipelineRunResult> {
    const stuckAfterMs = this.pipelineConfig.envs.RUN_STUCK_AFTER_MS;
    const aliveSinceMs = (
      existingRun.startedAt ?? existingRun.queuedAt
    ).getTime();
    const ageMs = Date.now() - aliveSinceMs;

    if (ageMs < stuckAfterMs) {
      this.logger.info(
        { ageMs, mrIid, projectId, runId: existingRun.id, stuckAfterMs },
        "Skipping duplicate review (already in progress)"
      );
      return { outcome: "skipped", reason: "already_in_progress" };
    }

    this.logger.warn(
      { ageMs, mrIid, projectId, runId: existingRun.id, stuckAfterMs },
      "Reclaiming stuck review run — marking failed before starting new attempt"
    );
    await this.infraRepoPorts.reviewRunRepo.updateStatus(
      existingRun.id,
      "failed",
      new Date()
    );
    await this.infraRepoPorts.reviewRunRepo.updateStats(existingRun.id, {
      errorMessage: `reclaimed: stuck in_progress for ${String(ageMs)}ms (threshold ${String(stuckAfterMs)}ms)`,
    });
    return { outcome: "proceeded" };
  }

  async markRunFailed(reviewRunId: string, err: unknown): Promise<void> {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await this.infraRepoPorts.reviewRunRepo.updateStatus(
      reviewRunId,
      "failed",
      new Date()
    );
    await this.infraRepoPorts.reviewRunRepo.updateStats(reviewRunId, {
      errorMessage,
    });
  }
}

export { ReviewRunLifecycleService };
