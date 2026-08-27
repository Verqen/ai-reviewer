import { describe, expect, it, vi } from "vitest";

import { OPENROUTER_REVIEW_MODEL } from "~/config/models";
import { CostBudget } from "~/domain/cost-budget";
import type { ReviewFinding } from "~/domain/types/review.types";
import { createMockLlmClient } from "~/test-utils/mock-llm-client";
import { createMockLogger } from "~/test-utils/mock-logger";

import {
  CLARIFICATION_REPLY_COST_CEILING,
  runNarrowFindingClarification,
} from "./review-narrow-finding-clarification";

function buildFinding(): ReviewFinding {
  return {
    category: "best_practice",
    comment: "This branch is unreachable",
    confidence: 0.9,
    filePath: "src/foo.ts",
    id: "finding-1",
    lineNumber: 12,
    lineType: "added",
    model: OPENROUTER_REVIEW_MODEL,
    passName: "file-review",
    resolution: "pending",
    reviewRunId: "run-1",
    severity: "warning",
  };
}

describe("runNarrowFindingClarification", () => {
  it("records the cost of the clarification call on the budget", async () => {
    const llm = createMockLlmClient({
      responses: [
        {
          content: "Guard the branch with an explicit check.",
          toolCalls: [],
          usage: { completionTokens: 300, promptTokens: 5_000 },
        },
      ],
    });
    const costBudget = new CostBudget(10);

    const reply = await runNarrowFindingClarification({
      costBudget,
      costModel: OPENROUTER_REVIEW_MODEL,
      developerNote: "How do I fix it?",
      finding: buildFinding(),
      language: "en",
      llm,
      logger: createMockLogger(),
    });

    expect(reply).toBe("Guard the branch with an explicit check.");
    expect(costBudget.spent).toBeGreaterThan(0);
  });

  it("skips the LLM call and returns the ceiling notice when the budget is exhausted", async () => {
    const llm = createMockLlmClient({ defaultContent: "should not be used" });
    const logger = createMockLogger();
    const warn = vi.spyOn(logger, "warn");
    const costBudget = new CostBudget(0);

    const reply = await runNarrowFindingClarification({
      costBudget,
      costModel: OPENROUTER_REVIEW_MODEL,
      developerNote: "How do I fix it?",
      finding: buildFinding(),
      language: "en",
      llm,
      logger,
    });

    expect(reply).toBe(CLARIFICATION_REPLY_COST_CEILING);
    expect(llm.calls.chatCompletion).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });
});
