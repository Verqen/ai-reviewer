import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { CostBudget } from "~/domain/cost-budget";
import type { ICodeHost } from "~/domain/ports/code-host.port";
import type { IReviewFindingRepository } from "~/domain/ports/review-finding.repository.port";
import type { ReviewFinding } from "~/domain/types/review.types";
import type { IReviewService } from "~/review/review.types";
import { createMockCodeHost } from "~/test-utils/mock-code-host";
import { createMockLogger } from "~/test-utils/mock-logger";
import { createMockReviewFindingRepository } from "~/test-utils/mock-review-finding-repository";
import { createMockReviewLearningService } from "~/test-utils/mock-review-learning-service";
import { createMockReviewService } from "~/test-utils/mock-review-service";

import type { ReviewLearningService } from "./review-learning.service";
import { ThreadManagerService } from "./thread-manager.service";

function buildMockFinding(
  overrides: Partial<ReviewFinding> = {},
): ReviewFinding {
  return {
    category: "best_practice",
    comment: "Avoid this anti-pattern",
    confidence: 0.9,
    filePath: "src/foo.ts",
    hostDiscussionId: "disc-1",
    id: "finding-1",
    lineNumber: 5,
    lineType: "added",
    model: "test-model",
    passName: "file-review",
    resolution: "pending",
    reviewRunId: "run-1",
    severity: "warning",
    ...overrides,
  };
}

describe("ThreadManagerService", () => {
  let findByProjectAndMrFn: Mock<
    IReviewFindingRepository["findByProjectAndMr"]
  >;
  let reviewFindingRepo: IReviewFindingRepository;
  let codeHost: ICodeHost;
  let classifyIntentFn: Mock<ReviewLearningService["classifyIntent"]>;
  let learnFromReplyFn: Mock<ReviewLearningService["learnFromReply"]>;
  let respondToFindingThreadClarificationFn: Mock<
    IReviewService["respondToFindingThreadClarification"]
  >;
  let reviewLearningService: ReviewLearningService;
  let reviewService: IReviewService;

  beforeEach(() => {
    codeHost = createMockCodeHost();
    findByProjectAndMrFn = vi
      .fn<IReviewFindingRepository["findByProjectAndMr"]>()
      .mockResolvedValue([buildMockFinding()]);
    classifyIntentFn = vi
      .fn<ReviewLearningService["classifyIntent"]>()
      .mockResolvedValue({
        intent: "false_positive",
        reason: "intentional by design",
      });
    learnFromReplyFn = vi
      .fn<ReviewLearningService["learnFromReply"]>()
      .mockResolvedValue(undefined);
    respondToFindingThreadClarificationFn = vi
      .fn<IReviewService["respondToFindingThreadClarification"]>()
      .mockResolvedValue("Narrow thread reply");

    reviewFindingRepo = createMockReviewFindingRepository({
      findByProjectAndMr: findByProjectAndMrFn,
    });

    reviewLearningService = createMockReviewLearningService({
      classifyIntent: classifyIntentFn,
      learnFromReply: learnFromReplyFn,
    });

    reviewService = createMockReviewService({
      respondToFindingThreadClarification:
        respondToFindingThreadClarificationFn,
    });
  });

  function buildService(): ThreadManagerService {
    return new ThreadManagerService(
      reviewFindingRepo,
      codeHost,
      reviewLearningService,
      reviewService,
      createMockLogger(),
    );
  }

  it("resolves thread and records learning for false_positive reply", async () => {
    const service = buildService();

    await service.handleReply({
      authorUsername: "dev-user",
      discussionId: "disc-1",
      mrIid: 1,
      noteBody: "This is intentional design",
      projectId: 1,
    });

    expect(learnFromReplyFn).toHaveBeenCalledWith(
      expect.objectContaining({
        authorUsername: "dev-user",
        classifiedIntent: {
          intent: "false_positive",
          reason: "intentional by design",
        },
        devReply: "This is intentional design",
        mrIid: 1,
        projectId: 1,
      }),
    );
  });

  it("resolves thread for accepted_debt", async () => {
    classifyIntentFn.mockResolvedValue({
      intent: "accepted_debt",
      reason: "trade-off",
    });

    const service = buildService();

    await service.handleReply({
      authorUsername: "dev-user",
      discussionId: "disc-1",
      mrIid: 1,
      noteBody: "We accept this as technical debt",
      projectId: 1,
    });

    expect(learnFromReplyFn).toHaveBeenCalled();
  });

  it("posts ack reply and resolves thread for agreement intent", async () => {
    classifyIntentFn.mockResolvedValue({
      intent: "agreement",
      reason: "developer agrees",
    });

    const resolveDiscussionSpy = vi.spyOn(codeHost, "resolveDiscussion");
    const replyToDiscussionSpy = vi.spyOn(codeHost, "replyToDiscussion");

    const service = buildService();

    await service.handleReply({
      authorUsername: "dev-user",
      discussionId: "disc-1",
      mrIid: 1,
      noteBody: "You are right, fixing this",
      projectId: 1,
    });

    expect(replyToDiscussionSpy).toHaveBeenCalledWith(
      1,
      1,
      "disc-1",
      expect.stringMatching(/Acknowledged/i),
    );
    expect(resolveDiscussionSpy).toHaveBeenCalledWith(1, 1, "disc-1");
    expect(learnFromReplyFn).not.toHaveBeenCalled();
  });

  it("delegates clarification to reviewService.respondToFindingThreadClarification", async () => {
    classifyIntentFn.mockResolvedValue({
      intent: "clarification",
      reason: "question asked",
    });

    const resolveDiscussionSpy = vi.spyOn(codeHost, "resolveDiscussion");
    const replyToDiscussionSpy = vi.spyOn(codeHost, "replyToDiscussion");

    const service = buildService();

    await service.handleReply({
      authorUsername: "dev-user",
      discussionId: "disc-1",
      mrIid: 1,
      noteBody: "What do you mean by this?",
      projectId: 1,
    });

    expect(respondToFindingThreadClarificationFn).toHaveBeenCalledTimes(1);
    expect(respondToFindingThreadClarificationFn).toHaveBeenCalledWith(
      1,
      1,
      expect.objectContaining({ id: "finding-1" }),
      "What do you mean by this?",
    );
    expect(replyToDiscussionSpy).toHaveBeenCalledWith(
      1,
      1,
      "disc-1",
      "Narrow thread reply",
    );
    expect(resolveDiscussionSpy).not.toHaveBeenCalled();
  });

  it("does not throw and skips reply when clarification answer fails", async () => {
    classifyIntentFn.mockResolvedValue({
      intent: "clarification",
      reason: "question asked",
    });
    respondToFindingThreadClarificationFn.mockRejectedValue(
      new Error("llm down"),
    );

    const replyToDiscussionSpy = vi.spyOn(codeHost, "replyToDiscussion");
    const service = buildService();

    await expect(
      service.handleReply({
        authorUsername: "dev-user",
        discussionId: "disc-1",
        mrIid: 1,
        noteBody: "?",
        projectId: 1,
      }),
    ).resolves.toBeUndefined();

    expect(replyToDiscussionSpy).not.toHaveBeenCalled();
  });

  it("ignores thread reply when no matching pending finding (no MR fetch, no LLM)", async () => {
    findByProjectAndMrFn.mockResolvedValue([]);

    const replyToDiscussionSpy = vi.spyOn(codeHost, "replyToDiscussion");
    const service = buildService();

    await service.handleReply({
      authorUsername: "dev-user",
      discussionId: "disc-99",
      mrIid: 1,
      noteBody: "some random comment",
      projectId: 1,
    });

    expect(classifyIntentFn).not.toHaveBeenCalled();
    expect(respondToFindingThreadClarificationFn).not.toHaveBeenCalled();
    expect(replyToDiscussionSpy).not.toHaveBeenCalled();
  });

  it("resolves thread for dispute intent", async () => {
    classifyIntentFn.mockResolvedValue({
      intent: "dispute",
      reason: "valid counter-argument",
    });

    const service = buildService();

    await service.handleReply({
      authorUsername: "dev-user",
      discussionId: "disc-1",
      mrIid: 1,
      noteBody: "Actually this is valid per spec X",
      projectId: 1,
    });

    expect(learnFromReplyFn).toHaveBeenCalledWith(
      expect.objectContaining({
        classifiedIntent: {
          intent: "dispute",
          reason: "valid counter-argument",
        },
      }),
    );
  });

  it("rolls back discussion resolution when learning persistence fails", async () => {
    learnFromReplyFn.mockRejectedValue(new Error("learning failed"));
    const unresolveDiscussionSpy = vi.spyOn(codeHost, "unresolveDiscussion");
    const service = buildService();
    await service.handleReply({
      authorUsername: "dev-user",
      discussionId: "disc-1",
      mrIid: 1,
      noteBody: "This is intentional design",
      projectId: 1,
    });
    expect(unresolveDiscussionSpy).toHaveBeenCalledWith(1, 1, "disc-1");
  });

  it("does not throw when rollback also fails", async () => {
    learnFromReplyFn.mockRejectedValue(new Error("learning failed"));
    vi.spyOn(codeHost, "unresolveDiscussion").mockRejectedValue(
      new Error("rollback failed"),
    );
    const service = buildService();
    await expect(
      service.handleReply({
        authorUsername: "dev-user",
        discussionId: "disc-1",
        mrIid: 1,
        noteBody: "This is intentional design",
        projectId: 1,
      }),
    ).resolves.toBeUndefined();
  });

  it("threads an exhausted cost budget into the learning service when the ceiling is zero", async () => {
    const service = new ThreadManagerService(
      reviewFindingRepo,
      codeHost,
      reviewLearningService,
      reviewService,
      createMockLogger(),
      0,
    );

    await service.handleReply({
      authorUsername: "dev-user",
      discussionId: "disc-1",
      mrIid: 1,
      noteBody: "This is intentional design",
      projectId: 1,
    });

    const budgetArgument: unknown = classifyIntentFn.mock.calls[0]?.[2];
    expect(budgetArgument).toBeInstanceOf(CostBudget);
    expect(
      budgetArgument instanceof CostBudget && budgetArgument.isExhausted(),
    ).toBe(true);
  });
});
