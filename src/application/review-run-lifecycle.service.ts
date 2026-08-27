import type { FastifyBaseLogger } from "fastify";

import type { ReviewInfraRepoPorts } from "~/application/review.infra-repo-ports";
import type { PipelineConfig } from "~/config/pipeline.config";
import { ReviewRunConflictError } from "~/domain/errors/review-run.errors";
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

class ReviewRunLifecycleService {
  static inject = [
    ReviewTokens.InfraRepoPorts,
    InjectionTokens.Logger,
    InjectionTokens.PipelineConfig,
  ] as const;

  constructor(
    private readonly infraRepoPorts: ReviewInfraRepoPorts,
    private readonly logger: FastifyBaseLogger,
    private readonly pipelineConfig: PipelineConfig,
  ) {}

  async startRun(
    params: StartPipelineRunParams,
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
          triggerType,
        );
      if (existingRun?.status === "completed") {
        this.logger.info(
          { mrIid, projectId, runId: existingRun.id },
          "Skipping duplicate review (DB dedup)",
        );
        return { outcome: "skipped", reason: "completed_duplicate" };
      }
      if (existingRun?.status === "in_progress") {
        return await this.handleInProgressRun(existingRun, params);
      }
      if (existingRun?.status === "failed") {
        return await this.restartFailedRun(existingRun, params);
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
        startedAt: new Date(),
        triggerType,
      });
    } catch (err) {
      if (err instanceof ReviewRunConflictError) {
        this.logger.info(
          { mrIid, projectId },
          "Skipping duplicate review (unique constraint)",
        );
        return { outcome: "skipped", reason: "unique_violation" };
      }
      throw err;
    }
    return { outcome: "started", reviewRun };
  }

  private async restartFailedRun(
    existingRun: ReviewRun,
    params: StartPipelineRunParams,
  ): Promise<StartPipelineRunResult> {
    const { isIncremental, mrIid, previousRunId, projectId, triggerType } =
      params;
    const restarted = await this.infraRepoPorts.reviewRunRepo.restartFailedRun({
      id: existingRun.id,
      isIncremental,
      previousRunId,
      startedAt: new Date(),
    });
    if (!restarted) {
      this.logger.info(
        { mrIid, projectId, runId: existingRun.id, triggerType },
        "Failed run was already picked up by another worker, skipping",
      );
      return { outcome: "skipped", reason: "already_in_progress" };
    }
    this.logger.warn(
      {
        mrIid,
        previousErrorMessage: existingRun.errorMessage,
        projectId,
        runId: existingRun.id,
        triggerType,
      },
      "Retrying a review whose previous attempt failed",
    );
    return { outcome: "started", reviewRun: restarted };
  }

  private async handleInProgressRun(
    existingRun: ReviewRun,
    params: StartPipelineRunParams,
  ): Promise<StartPipelineRunResult> {
    const { mrIid, projectId } = params;
    const stuckAfterMs = this.pipelineConfig.envs.RUN_STUCK_AFTER_MS;
    const aliveSinceMs = (
      existingRun.startedAt ?? existingRun.queuedAt
    ).getTime();
    const now = Date.now();
    const ageMs = now - aliveSinceMs;

    if (ageMs < stuckAfterMs) {
      this.logger.info(
        { ageMs, mrIid, projectId, runId: existingRun.id, stuckAfterMs },
        "Skipping duplicate review (already in progress)",
      );
      return { outcome: "skipped", reason: "already_in_progress" };
    }

    this.logger.warn(
      { ageMs, mrIid, projectId, runId: existingRun.id, stuckAfterMs },
      "Reclaiming stuck review run — restarting its attempt in place",
    );
    const reclaimed = await this.infraRepoPorts.reviewRunRepo.reclaimStuckRun({
      id: existingRun.id,
      isIncremental: params.isIncremental,
      previousRunId: params.previousRunId,
      startedAt: new Date(now),
      stuckBefore: new Date(now - stuckAfterMs),
    });
    if (!reclaimed) {
      this.logger.info(
        { mrIid, projectId, runId: existingRun.id },
        "Stuck run claimed by another worker, skipping",
      );
      return { outcome: "skipped", reason: "already_in_progress" };
    }
    return { outcome: "started", reviewRun: reclaimed };
  }

  async markRunFailed(reviewRunId: string, err: unknown): Promise<void> {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await this.infraRepoPorts.reviewRunRepo.failRun(reviewRunId, {
      errorMessage,
      timestamp: new Date(),
    });
  }
}

export { ReviewRunLifecycleService };
