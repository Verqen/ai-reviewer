import type { FastifyBaseLogger } from "fastify";

import type { ReviewInfraRepoPorts } from "~/application/review.infra-repo-ports";
import type { ICodeHost } from "~/domain/ports/code-host.port";
import type { IJobQueue } from "~/domain/ports/job-queue.port";
import type { ReviewJob } from "~/domain/types/job.types";

const MINUTES_TO_MS = 60 * 1000;
const COOLDOWN_MINUTES = 5;

interface MainPushReviewJob {
  changedFiles: string[];
  commitSha: string;
  defaultBranch: string;
  projectId: number;
}

class MainPushReviewService {
  constructor(
    private readonly infraRepoPorts: ReviewInfraRepoPorts,
    private readonly codeHost: ICodeHost,
    private readonly queue: IJobQueue<ReviewJob>,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async run(
    job: MainPushReviewJob,
    jobHandler: (job: ReviewJob) => Promise<void>,
  ): Promise<void> {
    const { changedFiles, commitSha, defaultBranch, projectId } = job;

    this.logger.info(
      { commitSha, defaultBranch, projectId },
      "Running main push re-review discovery",
    );

    const openMrs = await this.codeHost.listOpenMergeRequests(
      projectId,
      defaultBranch,
    );

    if (openMrs.length === 0) {
      this.logger.info({ projectId }, "No open MRs targeting default branch");
      return;
    }

    for (const mr of openMrs) {
      await this.processOpenMr(projectId, mr.iid, changedFiles, jobHandler);
    }
  }

  private async processOpenMr(
    projectId: number,
    mrIid: number,
    changedFiles: string[],
    jobHandler: (job: ReviewJob) => Promise<void>,
  ): Promise<void> {
    try {
      const mrDiffs = await this.codeHost.getMergeRequestDiff(projectId, mrIid);
      const changedSet = new Set(changedFiles);
      const hasOverlap = mrDiffs.some(
        (d) =>
          changedSet.has(d.newPath) ||
          (d.oldPath.length > 0 && changedSet.has(d.oldPath)),
      );

      if (!hasOverlap) {
        this.logger.debug(
          { mrIid, projectId },
          "No file overlap; skipping main-push re-review",
        );
        return;
      }

      const withinCooldown = await this.isWithinCooldown(projectId, mrIid);

      if (withinCooldown) {
        this.logger.info(
          { mrIid, projectId },
          "Within cooldown period; skipping main-push re-review",
        );
        return;
      }

      const reviewKey = `full_review:${projectId}:${mrIid}`;

      if (this.queue.isPending(reviewKey)) {
        this.logger.debug(
          { mrIid, projectId },
          "Review already in progress; skipping main-push re-review",
        );
        return;
      }

      const priorRun =
        await this.infraRepoPorts.reviewRunRepo.findLatestByProjectAndMr(
          projectId,
          mrIid,
          undefined,
          { includeFailedForBaseline: true },
        );

      const reviewJob: ReviewJob = priorRun
        ? {
            changedFiles,
            mrIid,
            previousRunId: priorRun.id,
            projectId,
            type: "main_push_scoped_review",
          }
        : {
            mrIid,
            projectId,
            triggerType: "main_push",
            type: "full_review",
          };

      const enqueued = this.queue.enqueue(reviewKey, reviewJob, jobHandler);

      if (enqueued) {
        this.logger.info({ mrIid, projectId }, "Enqueued main-push re-review");
      }
    } catch (err) {
      this.logger.warn(
        { err, mrIid, projectId },
        "Failed to process MR for main-push re-review",
      );
    }
  }

  private async isWithinCooldown(
    projectId: number,
    mrIid: number,
  ): Promise<boolean> {
    const latestRun =
      await this.infraRepoPorts.reviewRunRepo.findLatestByProjectAndMr(
        projectId,
        mrIid,
        "main_push",
      );

    if (!latestRun?.completedAt) {
      return false;
    }

    return (
      Date.now() - latestRun.completedAt.getTime() <
      COOLDOWN_MINUTES * MINUTES_TO_MS
    );
  }
}

export { MainPushReviewService };
export type { MainPushReviewJob };
