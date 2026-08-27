import { describe, expect, it, vi } from "vitest";

import type { IReviewFindingRepository } from "~/domain/ports/review-finding.repository.port";
import type { WebhookEvent } from "~/domain/types/code-host.types";
import type { ReviewJob } from "~/domain/types/job.types";
import { MemoryCache } from "~/infrastructure/cache/memory-cache";
import { JobQueue } from "~/infrastructure/queue/job-queue";
import { createMockCodeHost } from "~/test-utils/mock-code-host";
import { createMockInfraRepoPorts } from "~/test-utils/mock-infra-repo-ports";
import { createMockLogger } from "~/test-utils/mock-logger";

import { handleNote } from "./handle-note";
import type { WebhookOrchestratorDeps } from "./webhook-orchestration.types";

function buildDeps(options: { botDiscussionIds?: string[] } = {}): {
  deps: WebhookOrchestratorDeps;
  findByProjectAndMrSpy: ReturnType<typeof vi.fn>;
  queue: JobQueue<ReviewJob>;
} {
  const botDiscussionIds = new Set(options.botDiscussionIds ?? []);
  const ports = createMockInfraRepoPorts();
  const findByProjectAndMrSpy = vi.fn(() => Promise.resolve([]));
  const reviewFindingRepo: IReviewFindingRepository = {
    ...ports.reviewFindingRepo,
    existsByHostDiscussionId: (
      _projectId: number,
      _mrIid: number,
      hostDiscussionId: string,
    ) => Promise.resolve(botDiscussionIds.has(hostDiscussionId)),
    findByProjectAndMr: findByProjectAndMrSpy,
  };
  const queue = new JobQueue<ReviewJob>(5);
  const deps: WebhookOrchestratorDeps = {
    botUsername: "ai",
    cache: new MemoryCache<boolean>(),
    codeHost: createMockCodeHost(),
    jobHandler: () => Promise.resolve(),
    log: createMockLogger(),
    queue,
    reviewFindingRepo,
    reviewRunRepo: ports.reviewRunRepo,
    snapshotRepo: ports.snapshotRepo,
  };
  return { deps, findByProjectAndMrSpy, queue };
}

function buildNoteEvent(
  overrides: Partial<Extract<WebhookEvent, { type: "note" }>> = {},
): Extract<WebhookEvent, { type: "note" }> {
  return {
    authorUsername: "dev",
    mrIid: 7,
    note: "@ai what about this?",
    projectId: 42,
    type: "note",
    ...overrides,
  };
}

describe("handleNote", () => {
  it("enqueues a thread response for a bot discussion without loading every finding", async () => {
    const { deps, findByProjectAndMrSpy, queue } = buildDeps({
      botDiscussionIds: ["disc-bot"],
    });
    const enqueueSpy = vi.spyOn(queue, "enqueue");

    const result = await handleNote(
      deps,
      buildNoteEvent({ discussionId: "disc-bot" }),
    );

    expect(result).toEqual({ kind: "accepted" });
    expect(enqueueSpy).toHaveBeenCalledWith(
      "thread_response:42:7:disc-bot",
      expect.objectContaining({ type: "thread_response" }),
      deps.jobHandler,
    );
    expect(findByProjectAndMrSpy).not.toHaveBeenCalled();
  });

  it("ignores an unmentioned reply inside a bot discussion", async () => {
    const { deps } = buildDeps({ botDiscussionIds: ["disc-bot"] });

    const result = await handleNote(
      deps,
      buildNoteEvent({ discussionId: "disc-bot", note: "thanks team" }),
    );

    expect(result).toEqual({ kind: "ignored" });
  });

  it("enqueues a comment response for a mention in a foreign discussion", async () => {
    const { deps, queue } = buildDeps({ botDiscussionIds: ["disc-bot"] });
    const enqueueSpy = vi.spyOn(queue, "enqueue");

    const result = await handleNote(
      deps,
      buildNoteEvent({ discussionId: "disc-human" }),
    );

    expect(result).toEqual({ kind: "accepted" });
    expect(enqueueSpy).toHaveBeenCalledWith(
      "comment_response:42:7:disc-human",
      expect.objectContaining({ type: "comment_response" }),
      deps.jobHandler,
    );
  });

  it("enqueues a full review for a review request mention", async () => {
    const { deps, queue } = buildDeps({});
    const enqueueSpy = vi.spyOn(queue, "enqueue");

    const result = await handleNote(
      deps,
      buildNoteEvent({ note: "@ai review please" }),
    );

    expect(result).toEqual({ kind: "accepted" });
    expect(enqueueSpy).toHaveBeenCalledWith(
      "full_review:42:7",
      expect.objectContaining({ triggerType: "mention", type: "full_review" }),
      deps.jobHandler,
    );
  });

  it("uses the general comment response key when the note has no discussion", async () => {
    const { deps, queue } = buildDeps({});
    const enqueueSpy = vi.spyOn(queue, "enqueue");

    const result = await handleNote(deps, buildNoteEvent());

    expect(result).toEqual({ kind: "accepted" });
    expect(enqueueSpy).toHaveBeenCalledWith(
      "comment_response:42:7:general",
      expect.objectContaining({ type: "comment_response" }),
      deps.jobHandler,
    );
  });

  it("ignores notes authored by the bot", async () => {
    const { deps } = buildDeps({});

    const result = await handleNote(
      deps,
      buildNoteEvent({ authorUsername: "ai" }),
    );

    expect(result).toEqual({ kind: "ignored" });
  });
});
