import { describe, expect, it, vi } from "vitest";

import type { BaselineService } from "~/application/baseline.service";
import type { IncrementalReviewService } from "~/application/incremental-review.service";
import type { MainPushReviewService } from "~/application/main-push-review.service";
import type { ThreadManagerService } from "~/application/thread-manager.service";
import type { IJobQueue } from "~/domain/ports/job-queue.port";
import type { ReviewJob } from "~/domain/types/job.types";
import type { IReviewService } from "~/review/review.types";

import { createJobHandler } from "./job-handler";

function makeLogger() {
  return {
    child: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    level: "info",
    silent: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  };
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
  const enqueue = vi.fn().mockReturnValue(true);
  const isPending = vi.fn().mockReturnValue(false);
  const drain = vi.fn().mockResolvedValue(undefined);
  const queue = {
    drain,
    enqueue,
    isPending,
  } as unknown as IJobQueue<ReviewJob>;

  return { drain, enqueue, isPending, queue };
}

describe("createJobHandler", () => {
  it("calls reviewService.reviewMergeRequest for full_review job", async () => {
    const { reviewMergeRequest, service } = makeReviewService();
    const { queue } = makeQueue();
    const handler = createJobHandler(service, makeLogger() as never, { queue });

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
    const handler = createJobHandler(service, makeLogger() as never, {
      baselineService: {
        bootstrap: vi.fn(),
        executeWaitUntilBaselineReadyForReview,
        update: vi.fn(),
      } as unknown as BaselineService,
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
      executeWaitUntilBaselineReadyForReview.mock.invocationCallOrder[0]!
    ).toBeLessThan(reviewMergeRequest.mock.invocationCallOrder[0]!);
  });

  it("does not invoke executeWaitUntilBaselineReadyForReview for bootstrap_baseline", async () => {
    const executeWaitUntilBaselineReadyForReview = vi.fn();
    const { service } = makeReviewService();
    const { queue } = makeQueue();
    const bootstrap = vi.fn().mockResolvedValue(undefined);
    const handler = createJobHandler(service, makeLogger() as never, {
      baselineService: {
        bootstrap,
        executeWaitUntilBaselineReadyForReview,
        update: vi.fn(),
      } as unknown as BaselineService,
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
    const handler = createJobHandler(service, makeLogger() as never, {
      baselineService: {
        bootstrap: vi.fn(),
        executeWaitUntilBaselineReadyForReview,
        update: vi.fn(),
      } as unknown as BaselineService,
      incrementalReviewService: {
        run,
      } as unknown as IncrementalReviewService,
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
      executeWaitUntilBaselineReadyForReview.mock.invocationCallOrder[0]!
    ).toBeLessThan(run.mock.invocationCallOrder[0]!);
  });

  it("calls reviewService.respondToComment for comment_response job", async () => {
    const { respondToComment, service } = makeReviewService();
    const { queue } = makeQueue();
    const handler = createJobHandler(service, makeLogger() as never, { queue });
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
    const handler = createJobHandler(service, makeLogger() as never, {
      incrementalReviewService: { run } as unknown as IncrementalReviewService,
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
    const handler = createJobHandler(service, makeLogger() as never, {
      incrementalReviewService: {
        run: vi.fn(),
        runMainPushScopedReview,
      } as unknown as IncrementalReviewService,
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
    const handler = createJobHandler(service, makeLogger() as never, {
      baselineService: {
        bootstrap: vi.fn(),
        executeWaitUntilBaselineReadyForReview,
        update: vi.fn(),
      } as unknown as BaselineService,
      incrementalReviewService: {
        run: vi.fn(),
        runMainPushScopedReview,
      } as unknown as IncrementalReviewService,
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
      executeWaitUntilBaselineReadyForReview.mock.invocationCallOrder[0]!
    ).toBeLessThan(runMainPushScopedReview.mock.invocationCallOrder[0]!);
  });

  it("calls baselineService.bootstrap for bootstrap_baseline job", async () => {
    const { service } = makeReviewService();
    const { queue } = makeQueue();
    const bootstrap = vi.fn().mockResolvedValue(undefined);
    const handler = createJobHandler(service, makeLogger() as never, {
      baselineService: {
        bootstrap,
        update: vi.fn(),
      } as unknown as BaselineService,
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
    const { enqueue, isPending, queue } = makeQueue();
    const update = vi.fn().mockResolvedValue(undefined);
    const handler = createJobHandler(service, makeLogger() as never, {
      baselineService: {
        bootstrap: vi.fn(),
        update,
      } as unknown as BaselineService,
      mainPushReviewService: {
        run: vi.fn(),
      } as unknown as MainPushReviewService,
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
    expect(isPending).toHaveBeenCalledWith("main_push_re_review:10");
    expect(enqueue).toHaveBeenCalled();
  });

  it("does not enqueue re-review when already pending", async () => {
    const { service } = makeReviewService();
    const { enqueue, isPending, queue } = makeQueue();
    isPending.mockReturnValue(true);
    const handler = createJobHandler(service, makeLogger() as never, {
      baselineService: {
        bootstrap: vi.fn(),
        update: vi.fn().mockResolvedValue(undefined),
      } as unknown as BaselineService,
      mainPushReviewService: {
        run: vi.fn(),
      } as unknown as MainPushReviewService,
      queue,
    });

    await handler({
      changedFiles: [],
      commitSha: "sha2",
      defaultBranch: "main",
      projectId: 20,
      type: "update_baseline",
    });

    expect(enqueue).not.toHaveBeenCalled();
  });

  it("logs warning when bootstrap_baseline handler not configured", async () => {
    const { service } = makeReviewService();
    const { queue } = makeQueue();
    const logger = makeLogger();
    const handler = createJobHandler(service, logger as never, { queue });

    await handler({
      projectId: 1,
      type: "bootstrap_baseline",
    });

    const firstWarnCall = logger.warn.mock.calls[0];

    expect(firstWarnCall?.[0]).toMatchObject({
      job: { type: "bootstrap_baseline" },
    });
    expect(firstWarnCall?.[1]).toBe(
      "bootstrap_baseline handler not configured"
    );
  });

  it("calls threadManagerService.handleReply for thread_response job", async () => {
    const { service } = makeReviewService();
    const { queue } = makeQueue();
    const handleReply = vi.fn().mockResolvedValue(undefined);
    const handler = createJobHandler(service, makeLogger() as never, {
      queue,
      threadManagerService: { handleReply } as unknown as ThreadManagerService,
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
