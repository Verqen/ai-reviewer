import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { IncrementalReviewService } from "~/application/incremental-review.service";
import type { ICodeHost } from "~/domain/ports/code-host.port";
import type { IJobQueue } from "~/domain/ports/job-queue.port";
import type { IReviewRunRepository } from "~/domain/ports/review-run.repository.port";
import type { ReviewJob } from "~/domain/types/job.types";
import { MemoryCache } from "~/infrastructure/cache/memory-cache";
import { JobQueue } from "~/infrastructure/queue/job-queue";
import type { IReviewService } from "~/review/review.types";
import { createMockCodeHost } from "~/test-utils/mock-code-host";

import { webhookRoute } from "./webhook.route";

const MR_OPEN_PAYLOAD = {
  object_attributes: {
    action: "open",
    iid: 7,
    last_commit: { id: "abc123def456abc123def456abc123def456abc1" },
  },
  object_kind: "merge_request",
  project: { id: 42 },
};

const NOTE_PAYLOAD_PLAIN = {
  merge_request: { draft: false, iid: 7 },
  object_attributes: {
    discussion_id: "disc-abc123",
    note: "@ai can you explain this?",
    noteable_type: "MergeRequest",
    position: {
      new_line: 13,
      new_path: "src/services/user.service.ts",
      old_line: null,
      old_path: "src/services/user.service.ts",
    },
  },
  object_kind: "note",
  project: { id: 42 },
  user: { username: "developer1" },
};

const NOTE_PAYLOAD_REVIEW = {
  ...NOTE_PAYLOAD_PLAIN,
  object_attributes: {
    ...NOTE_PAYLOAD_PLAIN.object_attributes,
    note: "@ai review please",
  },
};

function buildMockGitLabConfig(botUsername = "ai") {
  return {
    envs: {
      GITLAB_API_URL: "https://gitlab.example.com",
      GITLAB_BOT_USERNAME: botUsername,
      GITLAB_TOKEN: "token",
    },
  };
}

function buildMockWebhookConfig(secret?: string) {
  return {
    envs: {
      WEBHOOK_MAX_QUEUE_SIZE: 150,
      WEBHOOK_SECRET: secret,
    },
  };
}

function buildMockReviewService(): IReviewService & {
  reviewCalls: Array<[number, number, string]>;
  respondCalls: Array<[number, number, unknown]>;
} {
  const reviewCalls: Array<[number, number, string]> = [];
  const respondCalls: Array<[number, number, unknown]> = [];

  return {
    respondCalls,
    respondToComment: vi.fn(
      (projectId: number, mrIid: number, context: unknown) => {
        respondCalls.push([projectId, mrIid, context]);
        return Promise.resolve();
      }
    ),
    respondToFindingThreadClarification: vi.fn().mockResolvedValue(""),
    reviewCalls,
    reviewMergeRequest: vi.fn(
      (projectId: number, mrIid: number, triggerType: string) => {
        reviewCalls.push([projectId, mrIid, triggerType]);
        return Promise.resolve();
      }
    ),
  };
}

function buildMockReviewRunRepo(): IReviewRunRepository {
  return {
    create: vi.fn(),
    findById: vi.fn().mockResolvedValue(undefined),
    findByIdentity: vi.fn().mockResolvedValue(undefined),
    findByProjectAndMr: vi.fn().mockResolvedValue([]),
    findLatestByProjectAndMr: vi.fn().mockResolvedValue(undefined),
    updateStats: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
  } as unknown as IReviewRunRepository;
}

function buildMockIncrementalReviewService(): IncrementalReviewService {
  return {
    run: vi.fn().mockResolvedValue(undefined),
  } as unknown as IncrementalReviewService;
}

function buildApp(options: {
  botUsername?: string;
  codeHost?: ICodeHost;
  queue?: IJobQueue<ReviewJob>;
  reviewer?: IReviewService;
  secret?: string;
}) {
  const app = Fastify({ logger: false });
  const cache = new MemoryCache<boolean>();
  const queue = options.queue ?? new JobQueue<ReviewJob>(5);
  const reviewer = options.reviewer ?? buildMockReviewService();

  const codeHost = options.codeHost ?? createMockCodeHost();
  const reviewRunRepo = buildMockReviewRunRepo();
  const incrementalReviewService = buildMockIncrementalReviewService();

  const reviewFindingRepo = {
    createMany: () => Promise.resolve([]),
    findByProjectAndMr: () => Promise.resolve([]),
    findByRunId: () => Promise.resolve([]),
    updateResolution: () => Promise.resolve(),
    updateResolutionMany: () => Promise.resolve(),
  };

  const baselineService = {
    bootstrap: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
  };

  const snapshotRepo = {
    copySnapshotEntries: vi.fn(),
    deleteCommit: vi.fn(),
    deleteOldSnapshotsBefore: vi.fn(),
    getBaselineState: vi
      .fn()
      .mockResolvedValue({ commitSha: "abc", status: "ready" }),
    getFileContent: vi.fn(),
    listFiles: vi.fn(),
    searchContent: vi.fn(),
    setBaselineState: vi.fn(),
    storeBlobs: vi.fn(),
    storeSnapshot: vi.fn(),
  };

  app.register(webhookRoute, {
    baselineService: baselineService as never,
    cache,
    codeHost,
    gitlabConfig: buildMockGitLabConfig(options.botUsername),
    incrementalReviewService,
    queue,
    reviewer,
    reviewFindingRepo,
    reviewRunRepo,
    snapshotRepo: snapshotRepo as never,
    webhookConfig: buildMockWebhookConfig(options.secret),
  });

  return { app, cache, queue, reviewer };
}

describe("webhookRoute", () => {
  describe("draft merge request", () => {
    it("returns 200 ignored for MR open as draft", async () => {
      const queue = new JobQueue<ReviewJob>(5);
      const { app } = buildApp({ queue });

      const response = await app.inject({
        body: {
          object_attributes: {
            action: "open",
            draft: true,
            iid: 7,
            last_commit: { id: "abc123def456abc123def456abc123def456abc1" },
          },
          object_kind: "merge_request",
          project: { id: 42 },
        },
        method: "POST",
        url: "/webhook",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: "ignored" });
      expect(queue.size).toBe(0);
    });

    it("returns 200 ignored for note when merge_request.draft is omitted", async () => {
      const queue = new JobQueue<ReviewJob>(5);
      const { app } = buildApp({ queue });

      const payload = {
        merge_request: { iid: 7 },
        object_attributes: NOTE_PAYLOAD_PLAIN.object_attributes,
        object_kind: "note",
        project: { id: 42 },
        user: { username: "developer1" },
      };

      const response = await app.inject({
        body: payload,
        method: "POST",
        url: "/webhook",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: "ignored" });
      expect(queue.size).toBe(0);
    });
  });

  describe("MR close and merge", () => {
    it("returns 200 ignored for MR close without enqueueing", async () => {
      const queue = new JobQueue<ReviewJob>(5);
      const { app } = buildApp({ queue });

      const response = await app.inject({
        body: {
          object_attributes: {
            action: "close",
            iid: 7,
          },
          object_kind: "merge_request",
          project: { id: 42 },
        },
        method: "POST",
        url: "/webhook",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: "ignored" });
      expect(queue.size).toBe(0);
    });
  });

  describe("MR open event", () => {
    it("returns 202 and enqueues full_review job", async () => {
      const enqueuedJobs: ReviewJob[] = [];
      const queue = new JobQueue<ReviewJob>(5);
      const originalEnqueue = queue.enqueue.bind(queue);
      queue.enqueue = (key, job, handler) => {
        enqueuedJobs.push(job);
        return originalEnqueue(key, job, handler);
      };

      const { app } = buildApp({ queue });

      const response = await app.inject({
        body: MR_OPEN_PAYLOAD,
        method: "POST",
        url: "/webhook",
      });

      expect(response.statusCode).toBe(202);
      expect(enqueuedJobs).toHaveLength(1);
      expect(enqueuedJobs[0]).toMatchObject({
        mrIid: 7,
        projectId: 42,
        triggerType: "mr_open",
        type: "full_review",
      });
    });

    it("uses key full_review:{projectId}:{mrIid}", async () => {
      const keys: string[] = [];
      const queue = new JobQueue<ReviewJob>(5);
      const originalEnqueue = queue.enqueue.bind(queue);
      queue.enqueue = (key, job, handler) => {
        keys.push(key);
        return originalEnqueue(key, job, handler);
      };

      const { app } = buildApp({ queue });

      await app.inject({
        body: MR_OPEN_PAYLOAD,
        method: "POST",
        url: "/webhook",
      });

      expect(keys[0]).toBe("full_review:42:7");
    });

    it("returns 409 when review already pending", async () => {
      const queue = new JobQueue<ReviewJob>(1);
      queue.enqueue(
        "full_review:42:7",
        {
          mrIid: 7,
          projectId: 42,
          triggerType: "mr_open",
          type: "full_review",
        },
        () => new Promise<void>((resolve) => setTimeout(resolve, 10_000))
      );

      const { app } = buildApp({ queue });

      const response = await app.inject({
        body: MR_OPEN_PAYLOAD,
        method: "POST",
        url: "/webhook",
      });

      expect(response.statusCode).toBe(409);
    });
  });

  describe("MR undraft event", () => {
    it("enqueues full_review with triggerType mr_undraft", async () => {
      const enqueuedJobs: ReviewJob[] = [];
      const queue = new JobQueue<ReviewJob>(5);
      const originalEnqueue = queue.enqueue.bind(queue);
      queue.enqueue = (key, job, handler) => {
        enqueuedJobs.push(job);
        return originalEnqueue(key, job, handler);
      };

      const { app } = buildApp({ queue });

      const payload = {
        changes: { draft: { current: false, previous: true } },
        object_attributes: {
          action: "update",
          iid: 7,
          last_commit: { id: "sha1" },
        },
        object_kind: "merge_request",
        project: { id: 42 },
      };

      const response = await app.inject({
        body: payload,
        method: "POST",
        url: "/webhook",
      });

      expect(response.statusCode).toBe(202);
      expect(enqueuedJobs[0]).toMatchObject({
        triggerType: "mr_undraft",
        type: "full_review",
      });
    });
  });

  describe("note event with plain @ai mention", () => {
    it("enqueues comment_response job", async () => {
      const enqueuedJobs: ReviewJob[] = [];
      const queue = new JobQueue<ReviewJob>(5);
      const originalEnqueue = queue.enqueue.bind(queue);
      queue.enqueue = (key, job, handler) => {
        enqueuedJobs.push(job);
        return originalEnqueue(key, job, handler);
      };

      const { app } = buildApp({ queue });

      const response = await app.inject({
        body: NOTE_PAYLOAD_PLAIN,
        method: "POST",
        url: "/webhook",
      });

      expect(response.statusCode).toBe(202);
      expect(enqueuedJobs).toHaveLength(1);
      expect(enqueuedJobs[0]).toMatchObject({
        mrIid: 7,
        projectId: 42,
        type: "comment_response",
      });
    });

    it("uses key comment_response:{projectId}:{mrIid}:{discussionId}", async () => {
      const keys: string[] = [];
      const queue = new JobQueue<ReviewJob>(5);
      const originalEnqueue = queue.enqueue.bind(queue);
      queue.enqueue = (key, job, handler) => {
        keys.push(key);
        return originalEnqueue(key, job, handler);
      };

      const { app } = buildApp({ queue });

      await app.inject({
        body: NOTE_PAYLOAD_PLAIN,
        method: "POST",
        url: "/webhook",
      });

      expect(keys[0]).toBe("comment_response:42:7:disc-abc123");
    });
  });

  describe("note event with @ai review", () => {
    it("enqueues full_review job with triggerType mention", async () => {
      const enqueuedJobs: ReviewJob[] = [];
      const queue = new JobQueue<ReviewJob>(5);
      const originalEnqueue = queue.enqueue.bind(queue);
      queue.enqueue = (key, job, handler) => {
        enqueuedJobs.push(job);
        return originalEnqueue(key, job, handler);
      };

      const { app } = buildApp({ queue });

      const response = await app.inject({
        body: NOTE_PAYLOAD_REVIEW,
        method: "POST",
        url: "/webhook",
      });

      expect(response.statusCode).toBe(202);
      expect(enqueuedJobs).toHaveLength(1);
      expect(enqueuedJobs[0]).toMatchObject({
        mrIid: 7,
        projectId: 42,
        triggerType: "mention",
        type: "full_review",
      });
    });

    it("uses key full_review:{projectId}:{mrIid} for @ai review", async () => {
      const keys: string[] = [];
      const queue = new JobQueue<ReviewJob>(5);
      const originalEnqueue = queue.enqueue.bind(queue);
      queue.enqueue = (key, job, handler) => {
        keys.push(key);
        return originalEnqueue(key, job, handler);
      };

      const { app } = buildApp({ queue });

      await app.inject({
        body: NOTE_PAYLOAD_REVIEW,
        method: "POST",
        url: "/webhook",
      });

      expect(keys[0]).toBe("full_review:42:7");
    });

    it("returns 409 when mention review collides with existing MR review", async () => {
      const queue = new JobQueue<ReviewJob>(5);
      queue.enqueue(
        "full_review:42:7",
        {
          mrIid: 7,
          projectId: 42,
          triggerType: "mr_open",
          type: "full_review",
        },
        () => new Promise<void>((resolve) => setTimeout(resolve, 10_000))
      );

      const { app } = buildApp({ queue });

      const response = await app.inject({
        body: NOTE_PAYLOAD_REVIEW,
        method: "POST",
        url: "/webhook",
      });

      expect(response.statusCode).toBe(409);
    });
  });

  describe("MR webhook payload validation", () => {
    it("rejects merge request update without last_commit.id", async () => {
      const queue = new JobQueue<ReviewJob>(5);
      const { app } = buildApp({ queue });

      const response = await app.inject({
        body: {
          object_attributes: {
            action: "update",
            iid: 7,
          },
          object_kind: "merge_request",
          project: { id: 42 },
        },
        method: "POST",
        url: "/webhook",
      });

      expect(response.statusCode).toBe(400);
      expect(queue.size).toBe(0);
    });
  });

  describe("duplicate key dedup", () => {
    it("returns 409 when comment_response already pending", async () => {
      const queue = new JobQueue<ReviewJob>(1);
      queue.enqueue(
        "comment_response:42:7:disc-abc123",
        {
          context: { note: "test" },
          mrIid: 7,
          projectId: 42,
          type: "comment_response",
        },
        () => new Promise<void>((resolve) => setTimeout(resolve, 10_000))
      );

      const { app } = buildApp({ queue });

      const response = await app.inject({
        body: NOTE_PAYLOAD_PLAIN,
        method: "POST",
        url: "/webhook",
      });

      expect(response.statusCode).toBe(409);
    });
  });

  describe("ignored events", () => {
    it("returns 200 ignored for bot's own note", async () => {
      const { app } = buildApp({ botUsername: "developer1" });

      const response = await app.inject({
        body: NOTE_PAYLOAD_PLAIN,
        method: "POST",
        url: "/webhook",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: "ignored" });
    });

    it("returns 200 ignored for note without bot mention", async () => {
      const payload = {
        ...NOTE_PAYLOAD_PLAIN,
        object_attributes: {
          ...NOTE_PAYLOAD_PLAIN.object_attributes,
          note: "Just a regular comment without the bot",
        },
      };
      const { app } = buildApp({});

      const response = await app.inject({
        body: payload,
        method: "POST",
        url: "/webhook",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: "ignored" });
    });

    it("returns 200 ignored for non-MR note events", async () => {
      const payload = {
        merge_request: null,
        object_attributes: {
          note: "@ai help",
          noteable_type: "Issue",
        },
        object_kind: "note",
        project: { id: 42 },
        user: { username: "developer1" },
      };
      const { app } = buildApp({});

      const response = await app.inject({
        body: payload,
        method: "POST",
        url: "/webhook",
      });

      expect(response.statusCode).toBe(400);
    });

    it("returns 202 for default branch push and 200 for non-default branch push", async () => {
      const defaultBranchPayload = {
        after: "sha2",
        before: "sha1",
        commits: [],
        object_kind: "push",
        project: { id: 42 },
        ref: "refs/heads/main",
      };
      const { app: defaultApp } = buildApp({});

      const defaultResponse = await defaultApp.inject({
        body: defaultBranchPayload,
        method: "POST",
        url: "/webhook",
      });

      expect(defaultResponse.statusCode).toBe(202);

      const featureBranchPayload = {
        after: "sha2",
        before: "sha1",
        commits: [],
        object_kind: "push",
        project: { id: 42 },
        ref: "refs/heads/feature/my-branch",
      };
      const { app: featureApp } = buildApp({});

      const featureResponse = await featureApp.inject({
        body: featureBranchPayload,
        method: "POST",
        url: "/webhook",
      });

      expect(featureResponse.statusCode).toBe(200);
      expect(featureResponse.json()).toMatchObject({ status: "ignored" });
    });
  });

  describe("invalid payloads", () => {
    it("returns 400 for empty body", async () => {
      const { app } = buildApp({});

      const response = await app.inject({
        method: "POST",
        url: "/webhook",
      });

      expect(response.statusCode).toBe(400);
    });

    it("returns 400 for unknown event kind", async () => {
      const { app } = buildApp({});

      const response = await app.inject({
        body: { object_kind: "pipeline" },
        method: "POST",
        url: "/webhook",
      });

      expect(response.statusCode).toBe(400);
    });

    it("returns 400 for MR event with missing required fields", async () => {
      const { app } = buildApp({});

      const response = await app.inject({
        body: { object_kind: "merge_request" },
        method: "POST",
        url: "/webhook",
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("webhook secret", () => {
    it("returns 401 when secret header is missing", async () => {
      const { app } = buildApp({ secret: "mysecret" });

      const response = await app.inject({
        body: MR_OPEN_PAYLOAD,
        method: "POST",
        url: "/webhook",
      });

      expect(response.statusCode).toBe(401);
    });

    it("returns 401 when secret header is wrong", async () => {
      const { app } = buildApp({ secret: "mysecret" });

      const response = await app.inject({
        body: MR_OPEN_PAYLOAD,
        headers: { "x-gitlab-token": "wrongsecret" },
        method: "POST",
        url: "/webhook",
      });

      expect(response.statusCode).toBe(401);
    });

    it("proceeds when secret matches", async () => {
      const { app } = buildApp({ secret: "mysecret" });

      const response = await app.inject({
        body: MR_OPEN_PAYLOAD,
        headers: { "x-gitlab-token": "mysecret" },
        method: "POST",
        url: "/webhook",
      });

      expect(response.statusCode).toBe(202);
    });
  });
});
