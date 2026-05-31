import type { FastifyBaseLogger } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MainPushReviewService } from "~/application/main-push-review.service";
import type { ReviewInfraRepoPorts } from "~/application/review.infra-repo-ports";
import type { ICodeHost } from "~/domain/ports/code-host.port";
import type { IJobQueue } from "~/domain/ports/job-queue.port";
import type { IReviewRunRepository } from "~/domain/ports/review-run.repository.port";
import type {
  DiffFile,
  MergeRequestInfo,
} from "~/domain/types/code-host.types";
import type { ReviewJob } from "~/domain/types/job.types";
import type { ReviewRun, TriggerType } from "~/domain/types/review.types";
import { createMockLogger } from "~/test-utils/mock-logger";

function makeDiff(path: string): DiffFile {
  return { diff: "", newPath: path, oldPath: path };
}

function makeMr(iid: number): MergeRequestInfo {
  return {
    description: "",
    iid,
    projectId: 1,
    sourceBranch: "feature",
    targetBranch: "main",
    title: "PR",
  };
}

function makeReviewRun(
  completedAt?: Date,
  triggerType: TriggerType = "mr_open",
  status: ReviewRun["status"] = "completed",
): ReviewRun {
  return {
    baseCommitSha: "base",
    completedAt,
    headCommitSha: "head",
    id: "run-1",
    isIncremental: false,
    mrIid: 1,
    projectId: 1,
    queuedAt: new Date(),
    status,
    triggerType,
  };
}

function makeRepo(): IReviewRunRepository & {
  findLatestByProjectAndMrFn: ReturnType<typeof vi.fn>;
} {
  const findLatestByProjectAndMrFn = vi.fn().mockResolvedValue(undefined);

  return {
    completeRun: vi.fn(),
    create: vi.fn(),
    deleteCompletedOrFailedBefore: vi.fn().mockResolvedValue(0),
    findById: vi.fn(),
    findByIdentity: vi.fn(),
    findByProjectAndMr: vi.fn(),
    findLatestByProjectAndMr: findLatestByProjectAndMrFn,
    findLatestByProjectAndMrFn,
    updateStats: vi.fn(),
    updateStatus: vi.fn(),
  };
}

function makeCodeHost(): ICodeHost & {
  getMergeRequestDiffFn: ReturnType<typeof vi.fn>;
  listOpenMergeRequestsFn: ReturnType<typeof vi.fn>;
} {
  const listOpenMergeRequestsFn = vi.fn().mockResolvedValue([]);
  const getMergeRequestDiffFn = vi.fn().mockResolvedValue([]);

  return {
    approveMergeRequest: () => Promise.resolve(),
    getCommitRangeDiff: () => Promise.resolve([]),
    getDefaultBranch: () => Promise.resolve("main"),
    getDiscussionNotes: () => Promise.resolve([]),
    getFileContent: () => Promise.resolve(""),
    getFileTree: () => Promise.resolve([]),
    getMergeRequestDiff: getMergeRequestDiffFn,
    getMergeRequestDiffFn,
    getMergeRequestInfo: () =>
      Promise.resolve({
        description: "",
        iid: 1,
        projectId: 1,
        sourceBranch: "f",
        targetBranch: "main",
        title: "t",
      }),
    getMergeRequestVersions: () =>
      Promise.resolve({ baseSha: "base", headSha: "head", startSha: "start" }),
    getRepositoryArchive: () => Promise.resolve([]),
    listOpenMergeRequests: listOpenMergeRequestsFn,
    listOpenMergeRequestsFn,
    postInlineComment: () =>
      Promise.resolve({ discussionId: "d", noteId: "n" }),
    postNote: () => Promise.resolve({ noteId: "n" }),
    replyToDiscussion: () => Promise.resolve({ noteId: "n" }),
    resolveDiscussion: () => Promise.resolve(),
    unapprove: () => Promise.resolve(),
    unresolveDiscussion: () => Promise.resolve(),
  } as unknown as ICodeHost & {
    getMergeRequestDiffFn: ReturnType<typeof vi.fn>;
    listOpenMergeRequestsFn: ReturnType<typeof vi.fn>;
  };
}

function makeQueue(): IJobQueue<ReviewJob> & {
  enqueueFn: ReturnType<typeof vi.fn>;
  isPendingFn: ReturnType<typeof vi.fn>;
} {
  const enqueueFn = vi.fn().mockReturnValue(true);
  const isPendingFn = vi.fn().mockReturnValue(false);

  return {
    activeCount: 0,
    drain: vi.fn(),
    enqueue: enqueueFn,
    enqueueFn,
    isPending: isPendingFn,
    isPendingFn,
    size: 0,
  };
}

describe("MainPushReviewService", () => {
  let reviewRunRepo: ReturnType<typeof makeRepo>;
  let infraRepoPorts: ReviewInfraRepoPorts;
  let codeHost: ReturnType<typeof makeCodeHost>;
  let queue: ReturnType<typeof makeQueue>;
  let logger: FastifyBaseLogger;
  let service: MainPushReviewService;
  const jobHandler = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    reviewRunRepo = makeRepo();
    infraRepoPorts = {
      dismissedPatternRepo: {} as ReviewInfraRepoPorts["dismissedPatternRepo"],
      reviewFindingRepo: {} as ReviewInfraRepoPorts["reviewFindingRepo"],
      reviewRunRepo,
      snapshotRepo: {} as ReviewInfraRepoPorts["snapshotRepo"],
    };
    codeHost = makeCodeHost();
    queue = makeQueue();
    logger = createMockLogger();
    service = new MainPushReviewService(
      infraRepoPorts,
      codeHost,
      queue,
      logger,
    );
    jobHandler.mockClear();
  });

  it("enqueues full_review when open MR has file overlap and no prior run", async () => {
    codeHost.listOpenMergeRequestsFn.mockResolvedValue([makeMr(7)]);
    codeHost.getMergeRequestDiffFn.mockResolvedValue([
      makeDiff("src/auth.service.ts"),
    ]);

    await service.run(
      {
        changedFiles: ["src/auth.service.ts"],
        commitSha: "newsha",
        defaultBranch: "main",
        projectId: 1,
      },
      jobHandler,
    );

    expect(reviewRunRepo.findLatestByProjectAndMrFn).toHaveBeenCalledWith(
      1,
      7,
      undefined,
      { includeFailedForBaseline: true },
    );
    expect(queue.enqueueFn).toHaveBeenCalledWith(
      "full_review:1:7",
      expect.objectContaining({
        mrIid: 7,
        triggerType: "main_push",
        type: "full_review",
      }),
      jobHandler,
    );
  });

  it("enqueues main_push_scoped_review when prior terminal run exists", async () => {
    reviewRunRepo.findLatestByProjectAndMrFn.mockImplementation(
      (_projectId: number, _mrIid: number, triggerType?: TriggerType) =>
        Promise.resolve(
          triggerType === "main_push"
            ? undefined
            : makeReviewRun(new Date(Date.now() - 600_000), "mr_open"),
        ),
    );
    codeHost.listOpenMergeRequestsFn.mockResolvedValue([makeMr(7)]);
    codeHost.getMergeRequestDiffFn.mockResolvedValue([
      makeDiff("src/auth.service.ts"),
    ]);
    const changedFiles = ["src/auth.service.ts"];

    await service.run(
      {
        changedFiles,
        commitSha: "newsha",
        defaultBranch: "main",
        projectId: 1,
      },
      jobHandler,
    );

    expect(queue.enqueueFn).toHaveBeenCalledWith(
      "full_review:1:7",
      {
        changedFiles,
        mrIid: 7,
        previousRunId: "run-1",
        projectId: 1,
        type: "main_push_scoped_review",
      },
      jobHandler,
    );
  });

  it("enqueues main_push_scoped_review when prior run is failed (baseline aligned with MR update)", async () => {
    reviewRunRepo.findLatestByProjectAndMrFn.mockImplementation(
      (_projectId: number, _mrIid: number, triggerType?: TriggerType) =>
        Promise.resolve(
          triggerType === "main_push"
            ? undefined
            : makeReviewRun(undefined, "push", "failed"),
        ),
    );
    codeHost.listOpenMergeRequestsFn.mockResolvedValue([makeMr(7)]);
    codeHost.getMergeRequestDiffFn.mockResolvedValue([
      makeDiff("src/auth.service.ts"),
    ]);
    const changedFiles = ["src/auth.service.ts"];

    await service.run(
      {
        changedFiles,
        commitSha: "newsha",
        defaultBranch: "main",
        projectId: 1,
      },
      jobHandler,
    );

    expect(queue.enqueueFn).toHaveBeenCalledWith(
      "full_review:1:7",
      expect.objectContaining({
        previousRunId: "run-1",
        type: "main_push_scoped_review",
      }),
      jobHandler,
    );
  });

  it("skips MR with no file overlap", async () => {
    codeHost.listOpenMergeRequestsFn.mockResolvedValue([makeMr(7)]);
    codeHost.getMergeRequestDiffFn.mockResolvedValue([
      makeDiff("src/unrelated.ts"),
    ]);

    await service.run(
      {
        changedFiles: ["src/auth.service.ts"],
        commitSha: "newsha",
        defaultBranch: "main",
        projectId: 1,
      },
      jobHandler,
    );

    expect(queue.enqueueFn).not.toHaveBeenCalled();
  });

  it("respects cooldown when last run was main_push within window", async () => {
    reviewRunRepo.findLatestByProjectAndMrFn.mockImplementation(
      (_projectId: number, _mrIid: number, triggerType?: TriggerType) =>
        Promise.resolve(
          triggerType === "main_push"
            ? makeReviewRun(new Date(Date.now() - 60_000), "main_push")
            : undefined,
        ),
    );
    codeHost.listOpenMergeRequestsFn.mockResolvedValue([makeMr(7)]);
    codeHost.getMergeRequestDiffFn.mockResolvedValue([
      makeDiff("src/auth.service.ts"),
    ]);

    await service.run(
      {
        changedFiles: ["src/auth.service.ts"],
        commitSha: "newsha",
        defaultBranch: "main",
        projectId: 1,
      },
      jobHandler,
    );

    expect(queue.enqueueFn).not.toHaveBeenCalled();
  });

  it("ignores cooldown when last main_push run was long ago (scoped review when prior exists)", async () => {
    reviewRunRepo.findLatestByProjectAndMrFn.mockImplementation(
      (_projectId: number, _mrIid: number, triggerType?: TriggerType) =>
        Promise.resolve(
          triggerType === "main_push"
            ? makeReviewRun(new Date(Date.now() - 600_000), "main_push")
            : makeReviewRun(new Date(Date.now() - 60_000), "mr_open"),
        ),
    );
    codeHost.listOpenMergeRequestsFn.mockResolvedValue([makeMr(7)]);
    codeHost.getMergeRequestDiffFn.mockResolvedValue([
      makeDiff("src/auth.service.ts"),
    ]);

    await service.run(
      {
        changedFiles: ["src/auth.service.ts"],
        commitSha: "newsha",
        defaultBranch: "main",
        projectId: 1,
      },
      jobHandler,
    );

    expect(queue.enqueueFn).toHaveBeenCalledWith(
      "full_review:1:7",
      expect.objectContaining({
        mrIid: 7,
        type: "main_push_scoped_review",
      }),
      jobHandler,
    );
  });

  it("skips when review already pending", async () => {
    queue.isPendingFn.mockReturnValue(true);
    codeHost.listOpenMergeRequestsFn.mockResolvedValue([makeMr(7)]);
    codeHost.getMergeRequestDiffFn.mockResolvedValue([
      makeDiff("src/auth.service.ts"),
    ]);

    await service.run(
      {
        changedFiles: ["src/auth.service.ts"],
        commitSha: "newsha",
        defaultBranch: "main",
        projectId: 1,
      },
      jobHandler,
    );

    expect(queue.enqueueFn).not.toHaveBeenCalled();
  });
});
