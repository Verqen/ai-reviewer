import type { FastifyBaseLogger } from "fastify";
import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";

import { BaselineService } from "~/application/baseline.service";
import { MainPushReviewService } from "~/application/main-push-review.service";
import type { IJobQueue } from "~/domain/ports/job-queue.port";
import type { ReviewJob } from "~/domain/types/job.types";
import type { IReviewService } from "~/review/review.types";
import { createMockBaselineService } from "~/test-utils/mock-baseline-service";
import { createMockCodeHost } from "~/test-utils/mock-code-host";
import { createMockIncrementalReviewService } from "~/test-utils/mock-incremental-review-service";
import { createMockInfraRepoPorts } from "~/test-utils/mock-infra-repo-ports";
import { createMockJobQueue } from "~/test-utils/mock-job-queue";
import { createMockLogger } from "~/test-utils/mock-logger";
import { createMockMainPushReviewService } from "~/test-utils/mock-main-push-review-service";
import { createMockThreadManagerService } from "~/test-utils/mock-thread-manager-service";

import { createJobHandler } from "./job-handler";

interface UnknownJobTypeDispatcher {
  dispatch(job: { type: string }): Promise<void>;
}

function makeRecordingLogger(): {
  error: Mock;
  logger: FastifyBaseLogger;
  warn: Mock;
} {
  const error = vi.fn();
  const warn = vi.fn();

  return { error, logger: createMockLogger({ error, warn }), warn };
}

function makeRealBaselineAndMainPushServices(queue: IJobQueue<ReviewJob>): {
  baselineService: BaselineService;
  mainPushReviewService: MainPushReviewService;
  update: Mock;
} {
  const { logger } = makeRecordingLogger();
  const infraRepoPorts = createMockInfraRepoPorts();
  const codeHost = createMockCodeHost();
  const baselineService = new BaselineService(
    infraRepoPorts.snapshotRepo,
    codeHost,
    logger,
  );
  const update = vi.spyOn(baselineService, "update").mockResolvedValue();
  const mainPushReviewService = new MainPushReviewService(
    infraRepoPorts,
    codeHost,
    queue,
    logger,
  );

  return { baselineService, mainPushReviewService, update };
}

function makeReviewService() {
  const respondToComment = vi.fn().mockResolvedValue(undefined);
  const respondToFindingThreadClarification = vi.fn().mockResolvedValue("");
  const reviewMergeRequest = vi.fn().mockResolvedValue(undefined);
  const service: IReviewService = {
    respondToComment,
    respondToFindingThreadClarification,
    reviewMergeRequest,
  };

  return {
    respondToComment,
    respondToFindingThreadClarification,
    reviewMergeRequest,
    service,
  };
}

function makeQueue() {
  const enqueue = vi
    .fn<IJobQueue<ReviewJob>["enqueue"]>()
    .mockReturnValue(true);
  const isPending = vi
    .fn<IJobQueue<ReviewJob>["isPending"]>()
    .mockReturnValue(false);
  const drain = vi
    .fn<IJobQueue<ReviewJob>["drain"]>()
    .mockResolvedValue(undefined);
  const queue = createMockJobQueue<ReviewJob>({ drain, enqueue, isPending });

  return { drain, enqueue, isPending, queue };
}

describe("createJobHandler", () => {
  it("calls reviewService.reviewMergeRequest for full_review job", async () => {
    const { reviewMergeRequest, service } = makeReviewService();
    const { queue } = makeQueue();
    const handler = createJobHandler(service, makeRecordingLogger().logger, {
      queue,
    });

    await handler({
      mrIid: 5,
      projectId: 1,
      triggerType: "mr_open",
      type: "full_review",
    });

    expect(reviewMergeRequest).toHaveBeenCalledWith(1, 5, "mr_open", undefined);
  });

  it("awaits executeWaitUntilBaselineReadyForReview before reviewMergeRequest when baseline configured", async () => {
    const executeWaitUntilBaselineReadyForReview = vi
      .fn()
      .mockResolvedValue(undefined);
    const { reviewMergeRequest, service } = makeReviewService();
    const { queue } = makeQueue();
    const handler = createJobHandler(service, makeRecordingLogger().logger, {
      baselineService: createMockBaselineService({
        executeWaitUntilBaselineReadyForReview,
      }),
      queue,
    });

    await handler({
      mrIid: 5,
      projectId: 99,
      triggerType: "mr_open",
      type: "full_review",
    });

    expect(executeWaitUntilBaselineReadyForReview).toHaveBeenCalledWith(99);
    expect(
      executeWaitUntilBaselineReadyForReview.mock.invocationCallOrder[0]!,
    ).toBeLessThan(reviewMergeRequest.mock.invocationCallOrder[0]!);
  });

  it("does not invoke executeWaitUntilBaselineReadyForReview for bootstrap_baseline", async () => {
    const executeWaitUntilBaselineReadyForReview = vi.fn();
    const { service } = makeReviewService();
    const { queue } = makeQueue();
    const bootstrap = vi.fn().mockResolvedValue(undefined);
    const handler = createJobHandler(service, makeRecordingLogger().logger, {
      baselineService: createMockBaselineService({
        bootstrap,
        executeWaitUntilBaselineReadyForReview,
      }),
      queue,
    });

    await handler({
      projectId: 10,
      type: "bootstrap_baseline",
    });

    expect(bootstrap).toHaveBeenCalledWith(10);
    expect(executeWaitUntilBaselineReadyForReview).not.toHaveBeenCalled();
  });

  it("awaits baseline wait before incrementalReviewService.run", async () => {
    const executeWaitUntilBaselineReadyForReview = vi
      .fn()
      .mockResolvedValue(undefined);
    const { service } = makeReviewService();
    const { queue } = makeQueue();
    const run = vi.fn().mockResolvedValue(undefined);
    const handler = createJobHandler(service, makeRecordingLogger().logger, {
      baselineService: createMockBaselineService({
        executeWaitUntilBaselineReadyForReview,
      }),
      incrementalReviewService: createMockIncrementalReviewService({ run }),
      queue,
    });

    await handler({
      mrIid: 3,
      newHeadSha: "abc",
      previousSha: "def",
      projectId: 44,
      triggerType: "push",
      type: "incremental_review",
    });

    expect(executeWaitUntilBaselineReadyForReview).toHaveBeenCalledWith(44);
    expect(
      executeWaitUntilBaselineReadyForReview.mock.invocationCallOrder[0]!,
    ).toBeLessThan(run.mock.invocationCallOrder[0]!);
  });

  it("calls reviewService.respondToComment for comment_response job", async () => {
    const { respondToComment, service } = makeReviewService();
    const { queue } = makeQueue();
    const handler = createJobHandler(service, makeRecordingLogger().logger, {
      queue,
    });
    const context = { note: "please clarify" };

    await handler({
      context,
      mrIid: 7,
      projectId: 2,
      type: "comment_response",
    });

    expect(respondToComment).toHaveBeenCalledWith(2, 7, context);
  });

  it("calls incrementalReviewService.run for incremental_review job", async () => {
    const { service } = makeReviewService();
    const { queue } = makeQueue();
    const run = vi.fn().mockResolvedValue(undefined);
    const handler = createJobHandler(service, makeRecordingLogger().logger, {
      incrementalReviewService: createMockIncrementalReviewService({ run }),
      queue,
    });

    await handler({
      mrIid: 3,
      newHeadSha: "abc",
      previousSha: "def",
      projectId: 1,
      triggerType: "push",
      type: "incremental_review",
    });

    expect(run).toHaveBeenCalledWith({
      mrIid: 3,
      newHeadSha: "abc",
      previousSha: "def",
      projectId: 1,
      triggerType: "push",
    });
  });

  it("calls incrementalReviewService.runMainPushScopedReview for main_push_scoped_review job", async () => {
    const { service } = makeReviewService();
    const { queue } = makeQueue();
    const runMainPushScopedReview = vi.fn().mockResolvedValue(undefined);
    const handler = createJobHandler(service, makeRecordingLogger().logger, {
      incrementalReviewService: createMockIncrementalReviewService({
        runMainPushScopedReview,
      }),
      queue,
    });

    await handler({
      changedFiles: ["src/a.ts"],
      mrIid: 8,
      previousRunId: "run-prev",
      projectId: 2,
      type: "main_push_scoped_review",
    });

    expect(runMainPushScopedReview).toHaveBeenCalledWith({
      changedFiles: ["src/a.ts"],
      mrIid: 8,
      previousRunId: "run-prev",
      projectId: 2,
    });
  });

  it("awaits baseline wait before runMainPushScopedReview", async () => {
    const executeWaitUntilBaselineReadyForReview = vi
      .fn()
      .mockResolvedValue(undefined);
    const { service } = makeReviewService();
    const { queue } = makeQueue();
    const runMainPushScopedReview = vi.fn().mockResolvedValue(undefined);
    const handler = createJobHandler(service, makeRecordingLogger().logger, {
      baselineService: createMockBaselineService({
        executeWaitUntilBaselineReadyForReview,
      }),
      incrementalReviewService: createMockIncrementalReviewService({
        runMainPushScopedReview,
      }),
      queue,
    });

    await handler({
      changedFiles: ["src/a.ts"],
      mrIid: 8,
      previousRunId: "run-prev",
      projectId: 77,
      type: "main_push_scoped_review",
    });

    expect(executeWaitUntilBaselineReadyForReview).toHaveBeenCalledWith(77);
    expect(
      executeWaitUntilBaselineReadyForReview.mock.invocationCallOrder[0]!,
    ).toBeLessThan(runMainPushScopedReview.mock.invocationCallOrder[0]!);
  });

  it("calls baselineService.bootstrap for bootstrap_baseline job", async () => {
    const { service } = makeReviewService();
    const { queue } = makeQueue();
    const bootstrap = vi.fn().mockResolvedValue(undefined);
    const handler = createJobHandler(service, makeRecordingLogger().logger, {
      baselineService: createMockBaselineService({ bootstrap }),
      queue,
    });

    await handler({
      projectId: 10,
      type: "bootstrap_baseline",
    });

    expect(bootstrap).toHaveBeenCalledWith(10);
  });

  it("calls baselineService.update and enqueues re-review for update_baseline job", async () => {
    const { service } = makeReviewService();
    const { enqueue, queue } = makeQueue();
    const update = vi.fn().mockResolvedValue(undefined);
    const handler = createJobHandler(service, makeRecordingLogger().logger, {
      baselineService: createMockBaselineService({ update }),
      mainPushReviewService: createMockMainPushReviewService(),
      queue,
    });

    await handler({
      changedFiles: ["src/foo.ts"],
      commitSha: "sha1",
      defaultBranch: "main",
      projectId: 10,
      type: "update_baseline",
    });

    expect(update).toHaveBeenCalledWith(10, "sha1", ["src/foo.ts"]);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0]).toBe("main_push_re_review:10");
  });

  it("warns when the follow-up re-review is dropped by the queue", async () => {
    const { service } = makeReviewService();
    const { enqueue, queue } = makeQueue();
    enqueue.mockReturnValue(false);
    const { logger, warn } = makeRecordingLogger();
    const { baselineService, mainPushReviewService } =
      makeRealBaselineAndMainPushServices(queue);
    const handler = createJobHandler(service, logger, {
      baselineService,
      mainPushReviewService,
      queue,
    });

    await handler({
      changedFiles: [],
      commitSha: "sha2",
      defaultBranch: "main",
      projectId: 20,
      type: "update_baseline",
    });

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: "main_push_re_review:20", projectId: 20 }),
      expect.stringContaining("main_push_re_review was not enqueued"),
    );
  });

  it("fails loudly on a job type the switch does not handle", async () => {
    const { service } = makeReviewService();
    const { queue } = makeQueue();
    const { error, logger } = makeRecordingLogger();
    const dispatcher: UnknownJobTypeDispatcher = {
      dispatch: createJobHandler(service, logger, { queue }),
    };

    await expect(
      dispatcher.dispatch({ type: "not_a_job_type" }),
    ).rejects.toThrow("Unhandled job type");
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ job: { type: "not_a_job_type" } }),
      expect.stringContaining("Unhandled job type"),
    );
  });

  it("logs warning when bootstrap_baseline handler not configured", async () => {
    const { service } = makeReviewService();
    const { queue } = makeQueue();
    const { logger, warn } = makeRecordingLogger();
    const handler = createJobHandler(service, logger, { queue });

    await handler({
      projectId: 1,
      type: "bootstrap_baseline",
    });

    const firstWarnCall = warn.mock.calls[0];

    expect(firstWarnCall?.[0]).toMatchObject({
      job: { type: "bootstrap_baseline" },
    });
    expect(firstWarnCall?.[1]).toBe(
      "bootstrap_baseline handler not configured",
    );
  });

  it("calls threadManagerService.handleReply for thread_response job", async () => {
    const { service } = makeReviewService();
    const { queue } = makeQueue();
    const handleReply = vi.fn().mockResolvedValue(undefined);
    const handler = createJobHandler(service, makeRecordingLogger().logger, {
      queue,
      threadManagerService: createMockThreadManagerService({ handleReply }),
    });

    await handler({
      authorUsername: "alice",
      discussionId: "disc-1",
      mrIid: 99,
      noteBody: "LGTM",
      projectId: 5,
      type: "thread_response",
    });

    expect(handleReply).toHaveBeenCalledWith({
      authorUsername: "alice",
      discussionId: "disc-1",
      mrIid: 99,
      noteBody: "LGTM",
      projectId: 5,
    });
  });
});
