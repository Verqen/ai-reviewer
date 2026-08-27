import type { FastifyBaseLogger } from "fastify";

import type { BaselineService } from "~/application/baseline.service";
import type { IncrementalReviewService } from "~/application/incremental-review.service";
import type { MainPushReviewService } from "~/application/main-push-review.service";
import { buildMainPushReReviewJobKey } from "~/application/review-job-key";
import type { ThreadManagerService } from "~/application/thread-manager.service";
import type { IJobQueue } from "~/domain/ports/job-queue.port";
import type { ReviewJob } from "~/domain/types/job.types";
import type { IReviewService } from "~/review/review.types";

interface JobHandlerOptions {
  baselineService?: BaselineService | undefined;
  incrementalReviewService?: IncrementalReviewService | undefined;
  mainPushReviewService?: MainPushReviewService | undefined;
  queue: IJobQueue<ReviewJob>;
  threadManagerService?: ThreadManagerService | undefined;
}

function createJobHandler(
  reviewService: IReviewService,
  logger: FastifyBaseLogger,
  options: JobHandlerOptions,
): (job: ReviewJob) => Promise<void> {
  const executeWaitForMrReviewBaseline = async (
    projectId: number,
  ): Promise<void> => {
    if (!options.baselineService) return;
    await options.baselineService.executeWaitUntilBaselineReadyForReview(
      projectId,
    );
  };
  const handler = async (job: ReviewJob): Promise<void> => {
    switch (job.type) {
      case "full_review":
        await executeWaitForMrReviewBaseline(job.projectId);
        return reviewService.reviewMergeRequest(
          job.projectId,
          job.mrIid,

          job.triggerType,
          job.previousRunId,
        );

      case "comment_response":
        return reviewService.respondToComment(
          job.projectId,
          job.mrIid,
          job.context,
        );

      case "incremental_review":
        if (!options.incrementalReviewService) {
          logger.warn({ job }, "incremental_review handler not configured");
          return;
        }

        await executeWaitForMrReviewBaseline(job.projectId);
        return options.incrementalReviewService.run({
          mrIid: job.mrIid,
          newHeadSha: job.newHeadSha,
          previousSha: job.previousSha,
          projectId: job.projectId,
          triggerType: job.triggerType,
        });

      case "main_push_scoped_review":
        if (!options.incrementalReviewService) {
          logger.warn(
            { job },
            "main_push_scoped_review handler not configured",
          );
          return;
        }

        await executeWaitForMrReviewBaseline(job.projectId);
        return options.incrementalReviewService.runMainPushScopedReview({
          changedFiles: job.changedFiles,
          mrIid: job.mrIid,
          previousRunId: job.previousRunId,
          projectId: job.projectId,
        });

      case "bootstrap_baseline":
        if (!options.baselineService) {
          logger.warn({ job }, "bootstrap_baseline handler not configured");
          return;
        }

        return options.baselineService.bootstrap(job.projectId);

      case "update_baseline": {
        if (!options.baselineService) {
          logger.warn({ job }, "update_baseline handler not configured");
          return;
        }

        await options.baselineService.update(
          job.projectId,
          job.commitSha,
          job.changedFiles,
        );

        if (!options.mainPushReviewService) {
          return;
        }

        const reReviewKey = buildMainPushReReviewJobKey(job.projectId);
        const reReviewEnqueued = options.queue.enqueue(
          reReviewKey,
          {
            changedFiles: job.changedFiles,
            commitSha: job.commitSha,
            defaultBranch: job.defaultBranch,
            projectId: job.projectId,
            type: "main_push_re_review",
          },
          handler,
        );

        if (!reReviewEnqueued) {
          logger.warn(
            { key: reReviewKey, projectId: job.projectId },
            "main_push_re_review was not enqueued, it is already pending or the queue is draining",
          );
        }

        return;
      }

      case "main_push_re_review":
        if (!options.mainPushReviewService) {
          logger.warn({ job }, "main_push_re_review handler not configured");
          return;
        }

        return options.mainPushReviewService.run(
          {
            changedFiles: job.changedFiles,
            commitSha: job.commitSha,
            defaultBranch: job.defaultBranch,
            projectId: job.projectId,
          },
          handler,
        );

      case "thread_response":
        if (!options.threadManagerService) {
          logger.warn({ job }, "thread_response handler not configured");
          return;
        }

        return options.threadManagerService.handleReply({
          authorUsername: job.authorUsername,
          discussionId: job.discussionId,
          mrIid: job.mrIid,
          noteBody: job.noteBody,
          projectId: job.projectId,
        });

      default: {
        const unhandledJob: never = job;
        logger.error({ job: unhandledJob }, "Unhandled job type");
        throw new Error("Unhandled job type");
      }
    }
  };

  return handler;
}

export { createJobHandler };
