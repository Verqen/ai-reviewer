import { beforeEach, describe, expect, it, vi } from "vitest";

import { CostBudget } from "~/domain/cost-budget";
import { createMockLogger } from "~/test-utils/mock-logger";

import { answerReviewThread } from "./github-thread-reply";

const llmUsage = vi.hoisted(() => ({ calls: 0 }));

vi.mock("~/config/github.config", () => ({
  GitHubConfig: class {
    readonly envs = { GITHUB_BOT_USERNAME: "bot" };
  },
}));

vi.mock("~/infrastructure/code-host/github/github.code-host", () => ({
  createGitHubOctokit: () => ({
    rest: {
      repos: {
        get: () => Promise.resolve({ data: { id: 7 } }),
      },
    },
  }),
  GitHubCodeHost: class {
    getMergeRequestDiff() {
      return Promise.resolve([
        {
          diff: "@@ -1,1 +1,2 @@\n+added line\n",
          newPath: "src/index.ts",
          oldPath: "src/index.ts",
        },
      ]);
    }

    getMergeRequestInfo() {
      return Promise.resolve({
        description: "",
        iid: 3,
        projectId: 7,
        sourceBranch: "feature",
        targetBranch: "main",
        title: "Test PR",
      });
    }

    replyToDiscussion() {
      return Promise.resolve();
    }
  },
}));

vi.mock("~/config/llm.config", () => ({
  LlmConfig: class {
    readonly envs = { LLM_PROVIDER: "openrouter" };
  },
}));

vi.mock("~/config/openrouter.config", async () => {
  const { OPENROUTER_REVIEW_MODEL } = await import("~/config/models");
  return {
    OpenRouterConfig: class {
      readonly envs = { OPENROUTER_MODEL: OPENROUTER_REVIEW_MODEL };
    },
  };
});

vi.mock("~/infrastructure/llm/openrouter/openrouter.client", () => ({
  OpenRouterClient: class {
    chatCompletion() {
      llmUsage.calls++;
      return Promise.resolve({
        content: "Use an explicit guard clause.",
        toolCalls: [],
        usage: { completionTokens: 400, promptTokens: 12_000 },
      });
    }
  },
}));

function buildOptions(costBudget: CostBudget) {
  return {
    costBudget,
    developerNote: "How do I fix it?",
    finding: {
      comment: "This branch is unreachable",
      filePath: "src/index.ts",
      line: 2,
    },
    logger: createMockLogger(),
    owner: "acme",
    pullRequestNumber: 3,
    replyToCommentId: "comment-1",
    repo: "widgets",
  };
}

describe("answerReviewThread cost ceiling", () => {
  beforeEach(() => {
    llmUsage.calls = 0;
  });

  it("records the reply cost on the operation budget", async () => {
    const costBudget = new CostBudget(10);

    const result = await answerReviewThread(buildOptions(costBudget));

    expect(result.posted).toBe(true);
    expect(result.tokenCostUsd).toBeGreaterThan(0);
    expect(costBudget.spent).toBe(result.tokenCostUsd);
  });

  it("skips the reply entirely when the budget is exhausted", async () => {
    const costBudget = new CostBudget(0);
    const options = buildOptions(costBudget);
    const warn = vi.spyOn(options.logger, "warn");

    const result = await answerReviewThread(options);

    expect(llmUsage.calls).toBe(0);
    expect(result).toEqual({ answer: "", posted: false, tokenCostUsd: 0 });
    expect(warn).toHaveBeenCalled();
  });
});
