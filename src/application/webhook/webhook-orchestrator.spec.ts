import type { IConfig } from "~/shared/config";
import { describe, expect, it, vi } from "vitest";

import type { GitLabConfigSchema } from "~/config/gitlab.config";
import type { IJobQueue } from "~/domain/ports/job-queue.port";
import type { IReviewFindingRepository } from "~/domain/ports/review-finding.repository.port";
import type { IReviewRunRepository } from "~/domain/ports/review-run.repository.port";
import type { ISnapshotRepository } from "~/domain/ports/snapshot.repository.port";
import type { WebhookEvent } from "~/domain/types/code-host.types";
import type { ReviewJob } from "~/domain/types/job.types";
import { MemoryCache } from "~/infrastructure/cache/memory-cache";
import { GitLabNotFoundError } from "~/infrastructure/code-host/gitlab/gitlab.code-host";
import { JobQueue } from "~/infrastructure/queue/job-queue";
import { createMockCodeHost } from "~/test-utils/mock-code-host";
import { createMockLogger } from "~/test-utils/mock-logger";

import type { WebhookOrchestratorDeps } from "./webhook-orchestration.types";
import { createWebhookOrchestrator } from "./webhook-orchestrator";

function buildGitlabConfig(botUsername = "ai"): IConfig<GitLabConfigSchema> {
  return {
    envs: {
      GITLAB_API_URL: "https://gitlab.example.com",
      GITLAB_BOT_USERNAME: botUsername,
      GITLAB_TOKEN: "token",
    },
  };
}

function buildDeps(overrides: Partial<WebhookOrchestratorDeps> = {}): {
  deps: WebhookOrchestratorDeps;
  jobHandler: ReturnType<typeof vi.fn>;
  queue: IJobQueue<ReviewJob>;
} {
  const queue = overrides.queue ?? new JobQueue<ReviewJob>(5);
  const jobHandler = vi.fn().mockResolvedValue(undefined);
  const deps: WebhookOrchestratorDeps = {
    cache: overrides.cache ?? new MemoryCache<boolean>(),
    codeHost: overrides.codeHost ?? createMockCodeHost(),
    gitlabConfig: overrides.gitlabConfig ?? buildGitlabConfig(),
    jobHandler: overrides.jobHandler ?? jobHandler,
    log: overrides.log ?? createMockLogger(),
    queue,
    reviewFindingRepo:
      overrides.reviewFindingRepo ??
      ({
        findByProjectAndMr: vi.fn().mockResolvedValue([]),
      } as unknown as IReviewFindingRepository),
    reviewRunRepo:
      overrides.reviewRunRepo ??
      ({
        findLatestByProjectAndMr: vi.fn().mockResolvedValue(undefined),
      } as unknown as IReviewRunRepository),
    snapshotRepo:
      overrides.snapshotRepo ??
      ({
        getBaselineState: vi
          .fn()
          .mockResolvedValue({ commitSha: "abc", status: "ready" }),
      } as unknown as ISnapshotRepository),
    ...overrides,
  };
  return { deps, jobHandler, queue };
}

describe("createWebhookOrchestrator", () => {
  it("enqueues full_review on mr_open and returns accepted", async () => {
    const { deps, queue } = buildDeps();
    const enqueueSpy = vi.spyOn(queue, "enqueue");
    const orchestrator = createWebhookOrchestrator(deps);
    const event: WebhookEvent = {
      headSha: "sha1",
      mrIid: 7,
      projectId: 42,
      type: "mr_open",
    };
    const actualResult = await orchestrator.handleEvent(event);
    expect(actualResult).toEqual({ kind: "accepted" });
    expect(enqueueSpy).toHaveBeenCalledWith(
      "full_review:42:7",
      expect.objectContaining({
        mrIid: 7,
        projectId: 42,
        triggerType: "mr_open",
        type: "full_review",
      }),
      deps.jobHandler,
    );
  });

  it("returns conflict when MR review is already pending", async () => {
    const { deps, queue } = buildDeps();
    queue.enqueue(
      "full_review:42:7",
      {
        mrIid: 7,
        projectId: 42,
        triggerType: "mr_open",
        type: "full_review",
      },
      () => new Promise<void>(() => {}),
    );
    const orchestrator = createWebhookOrchestrator(deps);
    const event: WebhookEvent = {
      headSha: "sha1",
      mrIid: 7,
      projectId: 42,
      type: "mr_open",
    };
    const actualResult = await orchestrator.handleEvent(event);
    expect(actualResult).toEqual({
      kind: "conflict",
      reason: "review_in_progress",
    });
  });

  it("enqueues full_review on mr_update when no previous run exists", async () => {
    const { deps, queue } = buildDeps();
    const enqueueSpy = vi.spyOn(queue, "enqueue");
    const orchestrator = createWebhookOrchestrator(deps);
    const event: WebhookEvent = {
      headSha: "new-sha",
      mrIid: 7,
      projectId: 42,
      type: "mr_update",
    };
    const actualResult = await orchestrator.handleEvent(event);
    expect(actualResult).toEqual({ kind: "accepted" });
    expect(enqueueSpy).toHaveBeenCalledWith(
      "full_review:42:7",
      expect.objectContaining({
        triggerType: "push",
        type: "full_review",
      }),
      deps.jobHandler,
    );
  });

  it("enqueues incremental_review when previous run exists and range diff succeeds", async () => {
    const codeHost = createMockCodeHost();
    const reviewRunRepo = {
      findLatestByProjectAndMr: vi.fn().mockResolvedValue({
        baseCommitSha: "base-sha",
        headCommitSha: "prev-sha",
      }),
    } as unknown as IReviewRunRepository;
    const { deps, queue } = buildDeps({ codeHost, reviewRunRepo });
    const enqueueSpy = vi.spyOn(queue, "enqueue");
    const orchestrator = createWebhookOrchestrator(deps);
    const event: WebhookEvent = {
      headSha: "new-sha",
      mrIid: 7,
      projectId: 42,
      type: "mr_update",
    };
    const actualResult = await orchestrator.handleEvent(event);
    expect(actualResult).toEqual({ kind: "accepted" });
    expect(enqueueSpy).toHaveBeenCalledWith(
      "full_review:42:7",
      expect.objectContaining({
        newHeadSha: "new-sha",
        previousSha: "prev-sha",
        triggerType: "push",
        type: "incremental_review",
      }),
      deps.jobHandler,
    );
  });

  it("uses webhook oldrev as previousSha for incremental review", async () => {
    const codeHost = createMockCodeHost();
    const reviewRunRepo = {
      findLatestByProjectAndMr: vi.fn().mockResolvedValue({
        baseCommitSha: "base-sha",
        headCommitSha: "prev-run-sha",
      }),
    } as unknown as IReviewRunRepository;
    const { deps, queue } = buildDeps({ codeHost, reviewRunRepo });
    const enqueueSpy = vi.spyOn(queue, "enqueue");
    const orchestrator = createWebhookOrchestrator(deps);
    const event: WebhookEvent = {
      headSha: "new-sha",
      mrIid: 7,
      previousHeadSha: "oldrev-sha",
      projectId: 42,
      type: "mr_update",
    };
    const actualResult = await orchestrator.handleEvent(event);
    expect(actualResult).toEqual({ kind: "accepted" });
    expect(enqueueSpy).toHaveBeenCalledWith(
      "full_review:42:7",
      expect.objectContaining({
        newHeadSha: "new-sha",
        previousSha: "oldrev-sha",
        triggerType: "push",
        type: "incremental_review",
      }),
      deps.jobHandler,
    );
  });

  it("uses force_push trigger when MR base sha changed after rebase", async () => {
    const codeHost = createMockCodeHost({
      versions: { baseSha: "base-new", headSha: "new-sha", startSha: "start" },
    });
    const reviewRunRepo = {
      findLatestByProjectAndMr: vi.fn().mockResolvedValue({
        baseCommitSha: "base-old",
        headCommitSha: "prev-sha",
      }),
    } as unknown as IReviewRunRepository;
    const { deps, queue } = buildDeps({ codeHost, reviewRunRepo });
    const enqueueSpy = vi.spyOn(queue, "enqueue");
    const compareSpy = vi.spyOn(codeHost, "getCommitRangeDiff");
    const orchestrator = createWebhookOrchestrator(deps);
    const event: WebhookEvent = {
      headSha: "new-sha",
      mrIid: 7,
      projectId: 42,
      type: "mr_update",
    };
    const actualResult = await orchestrator.handleEvent(event);
    expect(actualResult).toEqual({ kind: "accepted" });
    expect(compareSpy).not.toHaveBeenCalled();
    expect(enqueueSpy).toHaveBeenCalledWith(
      "full_review:42:7",
      expect.objectContaining({
        triggerType: "force_push",
        type: "incremental_review",
      }),
      deps.jobHandler,
    );
  });

  it("uses force_push trigger when commit range diff fails with not found", async () => {
    const codeHost = createMockCodeHost();
    vi.spyOn(codeHost, "getCommitRangeDiff").mockRejectedValue(
      new GitLabNotFoundError("missing"),
    );
    const reviewRunRepo = {
      findLatestByProjectAndMr: vi.fn().mockResolvedValue({
        baseCommitSha: "base-sha",
        headCommitSha: "prev-sha",
      }),
    } as unknown as IReviewRunRepository;
    const { deps, queue } = buildDeps({ codeHost, reviewRunRepo });
    const enqueueSpy = vi.spyOn(queue, "enqueue");
    const orchestrator = createWebhookOrchestrator(deps);
    const event: WebhookEvent = {
      headSha: "new-sha",
      mrIid: 7,
      projectId: 42,
      type: "mr_update",
    };
    const actualResult = await orchestrator.handleEvent(event);
    expect(actualResult).toEqual({ kind: "accepted" });
    expect(enqueueSpy).toHaveBeenCalledWith(
      "full_review:42:7",
      expect.objectContaining({
        triggerType: "force_push",
        type: "incremental_review",
      }),
      deps.jobHandler,
    );
  });

  it("enqueues incremental_review on mr_update when latest run is failed", async () => {
    const codeHost = createMockCodeHost();
    const findLatest = vi.fn().mockResolvedValue({
      baseCommitSha: "base-sha",
      headCommitSha: "prev-sha",
      id: "run-failed",
      status: "failed",
    });
    const reviewRunRepo = {
      findLatestByProjectAndMr: findLatest,
    } as unknown as IReviewRunRepository;
    const { deps, queue } = buildDeps({ codeHost, reviewRunRepo });
    const enqueueSpy = vi.spyOn(queue, "enqueue");
    const orchestrator = createWebhookOrchestrator(deps);
    const event: WebhookEvent = {
      headSha: "new-sha",
      mrIid: 7,
      projectId: 42,
      type: "mr_update",
    };
    const actualResult = await orchestrator.handleEvent(event);
    expect(actualResult).toEqual({ kind: "accepted" });
    expect(findLatest).toHaveBeenCalledWith(42, 7, undefined, {
      includeFailedForBaseline: true,
    });
    expect(enqueueSpy).toHaveBeenCalledWith(
      "full_review:42:7",
      expect.objectContaining({
        newHeadSha: "new-sha",
        previousSha: "prev-sha",
        type: "incremental_review",
      }),
      deps.jobHandler,
    );
  });

  it("returns ignored for note from bot username", async () => {
    const { deps } = buildDeps();
    const orchestrator = createWebhookOrchestrator(deps);
    const event: WebhookEvent = {
      authorUsername: "ai",
      mrIid: 7,
      note: "hello",
      projectId: 42,
      type: "note",
    };
    const actualResult = await orchestrator.handleEvent(event);
    expect(actualResult).toEqual({ kind: "ignored" });
  });

  it("enqueues full_review with mention trigger for @ai review note", async () => {
    const { deps, queue } = buildDeps();
    const enqueueSpy = vi.spyOn(queue, "enqueue");
    const orchestrator = createWebhookOrchestrator(deps);
    const event: WebhookEvent = {
      authorUsername: "dev",
      discussionId: "disc-1",
      mrIid: 7,
      note: "@ai review please",
      projectId: 42,
      type: "note",
    };
    const actualResult = await orchestrator.handleEvent(event);
    expect(actualResult).toEqual({ kind: "accepted" });
    expect(enqueueSpy).toHaveBeenCalledWith(
      "full_review:42:7",
      expect.objectContaining({
        triggerType: "mention",
        type: "full_review",
      }),
      deps.jobHandler,
    );
  });

  it("enqueues comment_response for @ai non-review mention with discussion", async () => {
    const { deps, queue } = buildDeps();
    const enqueueSpy = vi.spyOn(queue, "enqueue");
    const orchestrator = createWebhookOrchestrator(deps);
    const event: WebhookEvent = {
      authorUsername: "dev",
      discussionId: "disc-abc",
      mrIid: 7,
      note: "@ai can you explain this?",
      position: { newLine: 1, newPath: "a.ts" },
      projectId: 42,
      type: "note",
    };
    const actualResult = await orchestrator.handleEvent(event);
    expect(actualResult).toEqual({ kind: "accepted" });
    expect(enqueueSpy).toHaveBeenCalledWith(
      "comment_response:42:7:disc-abc",
      expect.objectContaining({ type: "comment_response" }),
      deps.jobHandler,
    );
  });

  it("returns accepted for push to default branch", async () => {
    const codeHost = createMockCodeHost({ defaultBranch: "main" });
    const { deps } = buildDeps({ codeHost });
    const orchestrator = createWebhookOrchestrator(deps);
    const event: WebhookEvent = {
      afterSha: "a2",
      beforeSha: "a1",
      commits: [],
      projectId: 42,
      ref: "refs/heads/main",
      type: "push",
    };
    const actualResult = await orchestrator.handleEvent(event);
    expect(actualResult).toEqual({ kind: "accepted" });
  });

  it("returns ignored for push to non-default branch", async () => {
    const codeHost = createMockCodeHost({ defaultBranch: "main" });
    const { deps } = buildDeps({ codeHost });
    const orchestrator = createWebhookOrchestrator(deps);
    const event: WebhookEvent = {
      afterSha: "a2",
      beforeSha: "a1",
      commits: [],
      projectId: 42,
      ref: "refs/heads/feature/x",
      type: "push",
    };
    const actualResult = await orchestrator.handleEvent(event);
    expect(actualResult).toEqual({ kind: "ignored" });
  });

  describe("telemetry", () => {
    type LogMeta = Record<string, unknown>;
    type InfoSpy = ReturnType<
      typeof vi.fn<(meta: LogMeta, msg: string) => void>
    >;

    function buildLoggerWithSpyInfo(): {
      info: InfoSpy;
      logger: ReturnType<typeof createMockLogger>;
    } {
      const info: InfoSpy = vi.fn<(meta: LogMeta, msg: string) => void>();
      const logger = createMockLogger();
      Object.assign(logger, { info });
      return { info, logger };
    }

    it("logs 'Webhook event received' with event meta on entry", async () => {
      const { info, logger } = buildLoggerWithSpyInfo();
      const { deps } = buildDeps({ log: logger });
      const orchestrator = createWebhookOrchestrator(deps);
      await orchestrator.handleEvent({
        headSha: "sha1",
        mrIid: 7,
        projectId: 42,
        type: "mr_open",
      });
      const receivedCall = info.mock.calls.find(
        (call) => call[1] === "Webhook event received",
      );
      expect(receivedCall).toBeDefined();
      expect(receivedCall?.[0]).toMatchObject({
        headSha: "sha1",
        mrIid: 7,
        projectId: 42,
        type: "mr_open",
      });
    });

    it("logs 'Webhook event processed' with outcome and durationMs on exit", async () => {
      const { info, logger } = buildLoggerWithSpyInfo();
      const { deps } = buildDeps({ log: logger });
      const orchestrator = createWebhookOrchestrator(deps);
      await orchestrator.handleEvent({
        headSha: "sha1",
        mrIid: 7,
        projectId: 42,
        type: "mr_open",
      });
      const processedCall = info.mock.calls.find(
        (call) => call[1] === "Webhook event processed",
      );
      expect(processedCall).toBeDefined();
      expect(processedCall?.[0]).toMatchObject({
        mrIid: 7,
        outcome: "accepted",
        projectId: 42,
        type: "mr_open",
      });
      expect(typeof processedCall?.[0]?.["durationMs"]).toBe("number");
    });

    it("logs outcome=conflict with reason when queue is busy", async () => {
      const { info, logger } = buildLoggerWithSpyInfo();
      const { deps, queue } = buildDeps({ log: logger });
      queue.enqueue(
        "full_review:42:7",
        {
          mrIid: 7,
          projectId: 42,
          triggerType: "mr_open",
          type: "full_review",
        },
        () => new Promise<void>(() => {}),
      );
      const orchestrator = createWebhookOrchestrator(deps);
      await orchestrator.handleEvent({
        headSha: "sha1",
        mrIid: 7,
        projectId: 42,
        type: "mr_open",
      });
      const processedCall = info.mock.calls.find(
        (call) => call[1] === "Webhook event processed",
      );
      expect(processedCall?.[0]).toMatchObject({
        outcome: "conflict",
        reason: "review_in_progress",
      });
    });
  });
});
