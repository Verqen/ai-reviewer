import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DismissedPattern } from "~/domain/ports/dismissed-pattern.repository.port";
import type { IDismissedPatternRepository } from "~/domain/ports/dismissed-pattern.repository.port";
import type { IReviewFindingRepository } from "~/domain/ports/review-finding.repository.port";
import type { ReviewFinding } from "~/domain/types/review.types";
import { createMockLlmClient } from "~/test-utils/mock-llm-client";
import { createMockLogger } from "~/test-utils/mock-logger";

import { ReviewLearningService } from "./review-learning.service";

function buildMockFinding(
  overrides: Partial<ReviewFinding> = {}
): ReviewFinding {
  return {
    category: "best_practice",
    comment: "This pattern is unnecessary",
    confidence: 0.8,
    filePath: "src/foo.ts",
    id: "finding-1",
    lineNumber: 10,
    lineType: "added",
    model: "test-model",
    passName: "file-review",
    resolution: "pending",
    reviewRunId: "run-1",
    severity: "warning",
    ...overrides,
  };
}

function buildMockDismissedPattern(
  overrides: Partial<DismissedPattern> = {}
): DismissedPattern {
  return {
    category: "best_practice",
    createdAt: new Date(),
    id: "pattern-1",
    occurrenceCount: 2,
    patternDescription: "Unnecessary pattern dismissed",
    projectId: 1,
    severity: "warning",
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("ReviewLearningService", () => {
  let createFn: ReturnType<typeof vi.fn>;
  let findSimilarFn: ReturnType<typeof vi.fn>;
  let incrementOccurrenceFn: ReturnType<typeof vi.fn>;
  let updateResolutionFn: ReturnType<typeof vi.fn>;
  let dismissedPatternRepo: IDismissedPatternRepository;
  let reviewFindingRepo: IReviewFindingRepository;

  beforeEach(() => {
    createFn = vi.fn().mockResolvedValue(buildMockDismissedPattern());
    findSimilarFn = vi.fn().mockResolvedValue(undefined);
    incrementOccurrenceFn = vi.fn().mockResolvedValue(undefined);
    updateResolutionFn = vi.fn().mockResolvedValue(undefined);

    dismissedPatternRepo = {
      create: createFn,
      findByProject: vi.fn().mockResolvedValue([]),
      findSimilar: findSimilarFn,
      incrementOccurrence: incrementOccurrenceFn,
    };

    reviewFindingRepo = {
      createMany: vi.fn().mockResolvedValue([]),
      findByProjectAndMr: vi.fn().mockResolvedValue([]),
      findByRunId: vi.fn().mockResolvedValue([]),
      updateResolution: updateResolutionFn,
      updateResolutionMany: vi.fn().mockResolvedValue(undefined),
    };
  });

  describe("classifyIntent", () => {
    it("classifies false positive", async () => {
      const llm = createMockLlmClient({
        responses: [
          {
            content: JSON.stringify({
              intent: "false_positive",
              reason: "intentional",
            }),
            toolCalls: [],
            usage: { completionTokens: 10, promptTokens: 5 },
          },
        ],
      });

      const service = new ReviewLearningService(
        dismissedPatternRepo,
        reviewFindingRepo,
        llm,
        createMockLogger()
      );

      const result = await service.classifyIntent(
        "This code smell is bad",
        "This is intentional, it's part of our design"
      );

      expect(result.intent).toBe("false_positive");
      expect(result.reason).toBe("intentional");
    });

    it("falls back to clarification on invalid LLM response", async () => {
      const llm = createMockLlmClient({
        responses: [
          {
            content: "not valid json",
            toolCalls: [],
            usage: { completionTokens: 5, promptTokens: 5 },
          },
        ],
      });

      const service = new ReviewLearningService(
        dismissedPatternRepo,
        reviewFindingRepo,
        llm,
        createMockLogger()
      );

      const result = await service.classifyIntent("bot comment", "dev reply");
      expect(result.intent).toBe("clarification");
    });

    it("falls back to clarification on empty LLM response", async () => {
      const llm = createMockLlmClient({
        responses: [
          {
            content: null,
            toolCalls: [],
            usage: { completionTokens: 0, promptTokens: 5 },
          },
        ],
      });

      const service = new ReviewLearningService(
        dismissedPatternRepo,
        reviewFindingRepo,
        llm,
        createMockLogger()
      );

      const result = await service.classifyIntent("bot comment", "dev reply");
      expect(result.intent).toBe("clarification");
    });

    it("falls back to clarification when LLM JSON intent is not a valid enum value", async () => {
      const llm = createMockLlmClient({
        responses: [
          {
            content: JSON.stringify({
              intent: "not_an_intent",
              reason: "x",
            }),
            toolCalls: [],
            usage: { completionTokens: 5, promptTokens: 5 },
          },
        ],
      });

      const service = new ReviewLearningService(
        dismissedPatternRepo,
        reviewFindingRepo,
        llm,
        createMockLogger()
      );

      const result = await service.classifyIntent("bot", "dev");
      expect(result.intent).toBe("clarification");
      expect(result.reason).toBe("");
    });

    it("sets maxPromptTokensHard=4000 budget on classify call", async () => {
      const llm = createMockLlmClient({
        responses: [
          {
            content: JSON.stringify({ intent: "agreement", reason: "ok" }),
            toolCalls: [],
            usage: { completionTokens: 5, promptTokens: 5 },
          },
        ],
      });

      const service = new ReviewLearningService(
        dismissedPatternRepo,
        reviewFindingRepo,
        llm,
        createMockLogger()
      );

      await service.classifyIntent("bot", "dev");

      const [, opts] = llm.calls.chatCompletion[0]!;
      expect(opts?.maxPromptTokensHard).toBe(6000);
    });

    it("system prompt explicitly distinguishes 'fix request' as clarification (not agreement)", async () => {
      const llm = createMockLlmClient({
        responses: [
          {
            content: JSON.stringify({
              intent: "clarification",
              reason: "asks for fix",
            }),
            toolCalls: [],
            usage: { completionTokens: 5, promptTokens: 5 },
          },
        ],
      });

      const service = new ReviewLearningService(
        dismissedPatternRepo,
        reviewFindingRepo,
        llm,
        createMockLogger()
      );

      await service.classifyIntent("BAD", "предложи исправление");

      const [messages] = llm.calls.chatCompletion[0]!;
      const systemMsg = messages.find((m) => m.role === "system");
      expect(systemMsg).toBeDefined();
      const systemText = Array.isArray(systemMsg!.content)
        ? systemMsg!.content.map((b) => b.text).join("\n")
        : systemMsg!.content;

      expect(systemText.toLowerCase()).toContain("decision order");
      expect(systemText.toLowerCase()).toContain("clarification");
      expect(systemText.toLowerCase()).toContain("agreement");
      expect(systemText.toLowerCase()).toContain(
        "any request for a fix, code, suggestion, example, or explanation is clarification, never agreement"
      );
      expect(systemText.toLowerCase()).toContain("предложи исправление");
    });
  });

  describe("answerClarification", () => {
    it("returns single LLM response trimmed and uses only finding context (no MR/file fetches)", async () => {
      const llm = createMockLlmClient({
        responses: [
          {
            content: "  Замените умножение на деление в строке 5.  ",
            toolCalls: [],
            usage: { completionTokens: 30, promptTokens: 100 },
          },
        ],
      });

      const service = new ReviewLearningService(
        dismissedPatternRepo,
        reviewFindingRepo,
        llm,
        createMockLogger()
      );

      const finding = buildMockFinding({
        comment: "Multiplication used instead of division",
        filePath: "src/calculator.ts",
        lineExcerpt: "return a * b;",
        lineNumber: 5,
      });

      const reply = await service.answerClarification(finding, "Как починить?");

      expect(reply).toBe("Замените умножение на деление в строке 5.");
      expect(llm.calls.chatCompletion).toHaveLength(1);
      expect(llm.calls.chatCompletionWithTools).toHaveLength(0);
    });

    it("sets maxPromptTokensHard=4000 budget on clarification call", async () => {
      const llm = createMockLlmClient({
        responses: [
          {
            content: "answer",
            toolCalls: [],
            usage: { completionTokens: 5, promptTokens: 5 },
          },
        ],
      });

      const service = new ReviewLearningService(
        dismissedPatternRepo,
        reviewFindingRepo,
        llm,
        createMockLogger()
      );

      await service.answerClarification(buildMockFinding(), "?");

      const [, opts] = llm.calls.chatCompletion[0]!;
      expect(opts?.maxPromptTokensHard).toBe(6000);
      expect(opts?.tools).toBeUndefined();
    });

    it("does NOT include any diff/MR-info hint in the prompt — only finding fields and devReply", async () => {
      const llm = createMockLlmClient({
        responses: [
          {
            content: "ok",
            toolCalls: [],
            usage: { completionTokens: 5, promptTokens: 5 },
          },
        ],
      });

      const service = new ReviewLearningService(
        dismissedPatternRepo,
        reviewFindingRepo,
        llm,
        createMockLogger()
      );

      const finding = buildMockFinding({
        comment: "BAD",
        filePath: "src/x.ts",
        lineNumber: 7,
      });

      await service.answerClarification(finding, "почему?");

      const [messages] = llm.calls.chatCompletion[0]!;
      const userText = messages
        .filter((m) => m.role === "user")
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join("\n");

      expect(userText).toContain("src/x.ts:7");
      expect(userText).toContain("BAD");
      expect(userText).toContain("почему?");
      expect(userText.toLowerCase()).not.toContain("branch:");
      expect(userText.toLowerCase()).not.toContain("mr:");
      expect(userText.toLowerCase()).not.toContain("diff:");
      expect(userText.toLowerCase()).not.toContain("@@ -");
    });

    it("returns fallback string when LLM yields empty content", async () => {
      const llm = createMockLlmClient({
        responses: [
          {
            content: "",
            toolCalls: [],
            usage: { completionTokens: 0, promptTokens: 5 },
          },
        ],
      });

      const service = new ReviewLearningService(
        dismissedPatternRepo,
        reviewFindingRepo,
        llm,
        createMockLogger()
      );

      const reply = await service.answerClarification(buildMockFinding(), "?");

      expect(reply).toMatch(/context/i);
    });

    it("system prompt scopes the reply to this comment only", async () => {
      const llm = createMockLlmClient({
        responses: [
          {
            content: "ok",
            toolCalls: [],
            usage: { completionTokens: 5, promptTokens: 5 },
          },
        ],
      });

      const service = new ReviewLearningService(
        dismissedPatternRepo,
        reviewFindingRepo,
        llm,
        createMockLogger()
      );

      await service.answerClarification(buildMockFinding(), "?");

      const [messages] = llm.calls.chatCompletion[0]!;
      const systemMsg = messages.find((m) => m.role === "system");
      expect(systemMsg).toBeDefined();
      const systemText = Array.isArray(systemMsg!.content)
        ? systemMsg!.content.map((b) => b.text).join("\n")
        : systemMsg!.content;

      expect(systemText.toLowerCase()).toContain(
        "answer the developer's specific question"
      );
      expect(systemText.toLowerCase()).toContain("maximum 3 short sentences");
      expect(systemText.toLowerCase()).not.toContain("[out_of_scope]");
    });
  });

  describe("learnFromReply", () => {
    it("creates new pattern when no similar pattern exists", async () => {
      const llm = createMockLlmClient({
        responses: [
          {
            content: JSON.stringify({
              intent: "false_positive",
              reason: "by design",
            }),
            toolCalls: [],
            usage: { completionTokens: 10, promptTokens: 5 },
          },
          {
            content: "Dismissing unnecessary pattern warnings",
            toolCalls: [],
            usage: { completionTokens: 10, promptTokens: 5 },
          },
        ],
      });

      const service = new ReviewLearningService(
        dismissedPatternRepo,
        reviewFindingRepo,
        llm,
        createMockLogger()
      );

      const finding = buildMockFinding();

      await service.learnFromReply({
        authorUsername: "dev-user",
        devReply: "This is intentional",
        finding,
        mrIid: 1,
        projectId: 1,
      });

      expect(findSimilarFn).toHaveBeenCalledWith(
        1,
        "best_practice",
        finding.comment
      );
      expect(createFn).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "best_practice",
          createdBy: "dev-user",
          projectId: 1,
        })
      );
      expect(updateResolutionFn).toHaveBeenCalledWith(
        "finding-1",
        "dismissed",
        "dev-user",
        "by design"
      );
    });

    it("increments existing pattern occurrence", async () => {
      const existingPattern = buildMockDismissedPattern();
      findSimilarFn.mockResolvedValue(existingPattern);

      const llm = createMockLlmClient({
        responses: [
          {
            content: JSON.stringify({
              intent: "false_positive",
              reason: "known",
            }),
            toolCalls: [],
            usage: { completionTokens: 10, promptTokens: 5 },
          },
        ],
      });

      const service = new ReviewLearningService(
        dismissedPatternRepo,
        reviewFindingRepo,
        llm,
        createMockLogger()
      );

      await service.learnFromReply({
        authorUsername: "dev-user",
        devReply: "this is fine",
        finding: buildMockFinding(),
        mrIid: 1,
        projectId: 1,
      });

      expect(incrementOccurrenceFn).toHaveBeenCalledWith(existingPattern.id);
      expect(createFn).not.toHaveBeenCalled();
    });

    it("does nothing for agreement intent", async () => {
      const llm = createMockLlmClient({
        responses: [
          {
            content: JSON.stringify({ intent: "agreement", reason: "agrees" }),
            toolCalls: [],
            usage: { completionTokens: 10, promptTokens: 5 },
          },
        ],
      });

      const service = new ReviewLearningService(
        dismissedPatternRepo,
        reviewFindingRepo,
        llm,
        createMockLogger()
      );

      await service.learnFromReply({
        authorUsername: "dev-user",
        devReply: "You are right, I will fix this",
        finding: buildMockFinding(),
        mrIid: 1,
        projectId: 1,
      });

      expect(findSimilarFn).not.toHaveBeenCalled();
      expect(updateResolutionFn).not.toHaveBeenCalled();
    });

    it("handles accepted_debt as wont_fix resolution", async () => {
      const llm = createMockLlmClient({
        responses: [
          {
            content: JSON.stringify({
              intent: "accepted_debt",
              reason: "trade-off",
            }),
            toolCalls: [],
            usage: { completionTokens: 10, promptTokens: 5 },
          },
          {
            content: "Accepted debt pattern",
            toolCalls: [],
            usage: { completionTokens: 5, promptTokens: 5 },
          },
        ],
      });

      const service = new ReviewLearningService(
        dismissedPatternRepo,
        reviewFindingRepo,
        llm,
        createMockLogger()
      );

      await service.learnFromReply({
        authorUsername: "dev-user",
        devReply: "We accept this as technical debt",
        finding: buildMockFinding(),
        mrIid: 1,
        projectId: 1,
      });

      expect(updateResolutionFn).toHaveBeenCalledWith(
        "finding-1",
        "wont_fix",
        "dev-user",
        "trade-off"
      );
    });

    it("reuses preclassified intent instead of reclassifying", async () => {
      const llm = createMockLlmClient({ responses: [] });
      const service = new ReviewLearningService(
        dismissedPatternRepo,
        reviewFindingRepo,
        llm,
        createMockLogger()
      );

      await service.learnFromReply({
        authorUsername: "dev-user",
        classifiedIntent: { intent: "false_positive", reason: "cached" },
        devReply: "This is intentional",
        finding: buildMockFinding(),
        mrIid: 1,
        projectId: 1,
      });

      expect(llm.calls.chatCompletion).toHaveLength(1);
    });
  });
});
