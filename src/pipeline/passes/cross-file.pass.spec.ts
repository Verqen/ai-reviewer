import { describe, expect, it, vi } from "vitest";

import {
  OPENROUTER_REVIEW_MODEL,
  OPENROUTER_TRIAGE_MODEL,
} from "~/config/models";
import { CostBudget } from "~/domain/cost-budget";
import type { IOverlayView } from "~/domain/ports/overlay-view.port";
import type { PassResult, ReviewContext } from "~/domain/types/pipeline.types";
import { createMockLlmClient } from "~/test-utils/mock-llm-client";
import { createMockLogger } from "~/test-utils/mock-logger";
import { createMockReviewConfig } from "~/test-utils/mock-review-config";

import { CrossFilePass } from "./cross-file.pass";

function buildDiffLines(count: number): Array<{
  content: string;
  hunkHeader: string;
  newLine: number;
  type: "added";
}> {
  return Array.from({ length: count }, (_, index) => ({
    content: `const value${index + 1} = ${index + 1};`,
    hunkHeader: "@@",
    newLine: index + 1,
    type: "added",
  }));
}

function buildExportedDiffLines(count: number): Array<{
  content: string;
  hunkHeader: string;
  newLine: number;
  type: "added";
}> {
  return Array.from({ length: count }, (_, i) => ({
    content: `export class Feature${String(i)} {}`,
    hunkHeader: "@@",
    newLine: i + 1,
    type: "added",
  }));
}

function buildContext(overrides: Partial<ReviewContext> = {}): ReviewContext {
  return {
    diffs: [
      {
        lines: buildDiffLines(80),
        newPath: "src/a.ts",
        oldPath: "src/a.ts",
      },
      {
        lines: buildDiffLines(80),
        newPath: "src/b.ts",
        oldPath: "src/b.ts",
      },
    ],
    isIncremental: false,
    mrIid: 1,
    mrInfo: {
      description: "",
      iid: 1,
      projectId: 1,
      sourceBranch: "feature",
      targetBranch: "main",
      title: "Test MR",
    },
    previousFindings: [],
    projectId: 1,

    reviewConfig: createMockReviewConfig({
      models: { premium: null, review: "review-model", triage: "triage-model" },
      severityThreshold: "info",
    }),

    reviewRunId: "run-1",
    toolCallCache: new Map<string, Promise<string>>(),
    versions: { baseSha: "base", headSha: "head", startSha: "start" },
    ...overrides,
  };
}

function buildCrossFileResponse(findingCount = 1): string {
  const findings = Array.from({ length: findingCount }, () => ({
    confidence: 0.8,
    file_path: "src/a.ts",
    line_number: 1,
    line_type: "added",
    rule_id: "R-025",
  }));

  return JSON.stringify({
    findings,
  });
}

function createMockOverlayView(
  searchResults: Record<string, string> = {},
): IOverlayView {
  return {
    createToolExecutor: () => () => Promise.resolve(""),
    readFile: (path) => Promise.resolve(`content of ${path}`),
    readFileAtBaseline: (path) =>
      Promise.resolve(`baseline content of ${path}`),
    searchContent: (pattern) =>
      Promise.resolve(
        searchResults[pattern] ?? `No matches found for: ${pattern}`,
      ),
  };
}

describe("CrossFilePass", () => {
  it("returns architecture findings from LLM response", async () => {
    const llm = createMockLlmClient({
      defaultContent: buildCrossFileResponse(2),
    });
    const pass = new CrossFilePass(llm, createMockLogger());
    const result = await pass.execute(buildContext(), new Map());

    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]?.category).toBe("architecture");
    expect(result.findings[0]?.ruleId).toBe("R-025");
    expect(result.findings[0]?.severity).toBe("warning");
    expect(result.findings[0]?.passName).toBe("cross-file");
    const [firstCall] = llm.calls.chatCompletion;
    expect(firstCall?.[1]?.model).toBe("review-model");
  });

  it("drops findings when line_number is not in parsed diff hunks", async () => {
    const llm = createMockLlmClient({
      defaultContent: JSON.stringify({
        findings: [
          {
            confidence: 0.8,
            file_path: "src/a.ts",
            line_number: 999,
            line_type: "added",
            rule_id: "R-025",
          },
        ],
      }),
    });
    const pass = new CrossFilePass(llm, createMockLogger());
    const result = await pass.execute(buildContext(), new Map());
    expect(result.findings).toHaveLength(0);
  });

  it("includes MR diffs compact and allowable anchors in user prompt", async () => {
    const llm = createMockLlmClient({
      defaultContent: buildCrossFileResponse(0),
    });
    const pass = new CrossFilePass(llm, createMockLogger());
    await pass.execute(buildContext(), new Map());
    const [firstCall] = llm.calls.chatCompletion;
    const userMessage = firstCall?.[0]?.find((m) => m.role === "user");
    expect(userMessage?.content).toContain("## MR diffs (compact)");
    expect(userMessage?.content).toContain("Allowable anchors");
  });

  it("uses chatCompletion not chatCompletionWithTools", async () => {
    const llm = createMockLlmClient({
      defaultContent: buildCrossFileResponse(0),
    });
    const pass = new CrossFilePass(llm, createMockLogger());
    await pass.execute(buildContext(), new Map());

    expect(llm.calls.chatCompletion).toHaveLength(1);
    expect(llm.calls.chatCompletionWithTools).toHaveLength(0);
  });

  it("injects repo path rules into system prompt", async () => {
    const llm = createMockLlmClient({
      defaultContent: buildCrossFileResponse(0),
    });
    const pass = new CrossFilePass(llm, createMockLogger());
    const customRules = "Cross-file custom rule from REVIEW.md";
    await pass.execute(
      buildContext({
        reviewConfig: createMockReviewConfig({
          models: {
            premium: null,
            review: "review-model",
            triage: "triage-model",
          },
          pathRules: [{ extraRules: customRules, path: "**" }],
          severityThreshold: "info",
        }),
      }),
      new Map(),
    );
    const [firstCall] = llm.calls.chatCompletion;
    const systemMessage = firstCall?.[0]?.find((m) => m.role === "system");
    expect(systemMessage?.content).toContain(customRules);
  });

  it("uses prior file-review findings in prompt context", async () => {
    const llm = createMockLlmClient({
      defaultContent: buildCrossFileResponse(0),
    });
    const pass = new CrossFilePass(llm, createMockLogger());

    const priorFindings: PassResult["findings"] = [
      {
        category: "correctness",
        comment: "Prior bug",
        confidence: 0.9,
        filePath: "src/a.ts",
        lineNumber: 5,
        lineType: "added",
        model: "review-model",
        passName: "file-review",
        ruleId: "R-013",
        severity: "attention",
      },
    ];

    const priorResults = new Map<string, PassResult>([
      [
        "file-review",
        {
          findings: priorFindings,
          metadata: {},
          tokenUsage: { completionTokens: 10, promptTokens: 5 },
        },
      ],
    ]);

    await pass.execute(buildContext(), priorResults);

    const [firstCall] = llm.calls.chatCompletion;
    const userMessage = firstCall?.[0]?.find((m) => m.role === "user");
    expect(userMessage?.content).toContain("[R-013] L5: Prior bug");
  });

  it("makes chatCompletion call without codebase context when overlayView is absent", async () => {
    const llm = createMockLlmClient({
      defaultContent: buildCrossFileResponse(0),
    });
    const pass = new CrossFilePass(llm, createMockLogger());
    await pass.execute(buildContext({ overlayView: undefined }), new Map());
    const [firstCall] = llm.calls.chatCompletion;
    expect(firstCall).toBeDefined();
    const userMessage = firstCall?.[0]?.find((m) => m.role === "user");
    expect(userMessage?.content).not.toContain("## Codebase context");
  });

  it("does NOT call searchContent — RAG over whole monorepo is removed", async () => {
    const llm = createMockLlmClient({
      defaultContent: buildCrossFileResponse(0),
    });
    const searchCalls: string[] = [];
    const mockOverlayView = createMockOverlayView();
    const trackingOverlayView: IOverlayView = {
      ...mockOverlayView,
      searchContent: (pattern, glob) => {
        searchCalls.push(pattern);
        return mockOverlayView.searchContent(pattern, glob);
      },
    };
    const pass = new CrossFilePass(llm, createMockLogger());
    await pass.execute(
      buildContext({
        diffs: [
          {
            lines: [...buildExportedDiffLines(3), ...buildDiffLines(65)],
            newPath: "src/a.ts",
            oldPath: "src/a.ts",
          },
          {
            lines: buildDiffLines(68),
            newPath: "src/b.ts",
            oldPath: "src/b.ts",
          },
        ],
        overlayView: trackingOverlayView,
      }),
      new Map(),
    );
    expect(searchCalls).toEqual([]);
    expect(llm.calls.chatCompletion).toHaveLength(1);
  });

  it("includes ONLY in-diff file content in user prompt (codebase context = readFile per diff)", async () => {
    const llm = createMockLlmClient({
      defaultContent: buildCrossFileResponse(0),
    });
    const readPaths: string[] = [];
    const mockOverlayView = createMockOverlayView();
    const trackingOverlayView: IOverlayView = {
      ...mockOverlayView,
      readFile: (path) => {
        readPaths.push(path);
        return Promise.resolve(`// content of ${path}`);
      },
      searchContent: () => {
        throw new Error(
          "searchContent must not be called by cross-file gatherContext",
        );
      },
    };
    const pass = new CrossFilePass(llm, createMockLogger());
    await pass.execute(
      buildContext({
        diffs: [
          {
            lines: buildDiffLines(70),
            newPath: "src/a.ts",
            oldPath: "src/a.ts",
          },
          {
            lines: buildDiffLines(60),
            newPath: "src/b.ts",
            oldPath: "src/b.ts",
          },
        ],
        overlayView: trackingOverlayView,
      }),
      new Map(),
    );
    expect(readPaths.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    const [firstCall] = llm.calls.chatCompletion;
    const userMessage = firstCall?.[0]?.find((m) => m.role === "user");
    expect(userMessage?.content).toContain("// content of src/a.ts");
    expect(userMessage?.content).toContain("// content of src/b.ts");
  });

  it("drops findings whose file_path is not in the diff (off-diff hard-filter)", async () => {
    const offDiffResponse = JSON.stringify({
      findings: [
        {
          confidence: 0.8,
          file_path: "apps/example-app/foo.ts",
          line_number: 1,
          line_type: "added",
          rule_id: "R-025",
        },
        {
          confidence: 0.8,
          file_path: "src/a.ts",
          line_number: 1,
          line_type: "added",
          rule_id: "R-025",
        },
      ],
    });
    const llm = createMockLlmClient({ defaultContent: offDiffResponse });
    const warnCalls: unknown[][] = [];
    const logger = createMockLogger();
    logger.warn = (...args: unknown[]): void => {
      warnCalls.push(args);
    };

    const pass = new CrossFilePass(llm, logger);
    const result = await pass.execute(buildContext(), new Map());

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.filePath).toBe("src/a.ts");
    expect(
      warnCalls.some((args) => {
        const meta = args[0] as { off_diff_path?: string } | undefined;
        return meta?.off_diff_path === "apps/example-app/foo.ts";
      }),
    ).toBe(true);
  });

  it("returns empty findings gracefully on LLM error", async () => {
    const llm = createMockLlmClient();
    llm.chatCompletion = () => Promise.reject(new Error("LLM error"));

    const pass = new CrossFilePass(llm, createMockLogger());
    const result = await pass.execute(buildContext(), new Map());

    expect(result.findings).toHaveLength(0);
  });

  it("runs cross-file when all triage batches fail parsing", async () => {
    const llm = createMockLlmClient({
      defaultContent: buildCrossFileResponse(2),
    });
    const pass = new CrossFilePass(llm, createMockLogger());

    const priorResults = new Map<string, PassResult>([
      [
        "triage",
        {
          findings: [],
          metadata: {
            decisions: [],
            parseFailures: 6,
            totalBatches: 6,
            triageSkipRate: 0,
            trivialHunkCount: 0,
            trivialKeys: new Set<string>(),
          },
          tokenUsage: { completionTokens: 100, promptTokens: 5_000 },
        },
      ],
    ]);

    const result = await pass.execute(buildContext(), priorResults);

    expect(llm.calls.chatCompletion).toHaveLength(1);
    expect(result.metadata["skipped"]).not.toBe("triage_unreliable");
    expect(result.findings).toHaveLength(2);
  });

  it("returns empty findings when LLM returns null content", async () => {
    const llm = createMockLlmClient();
    llm.chatCompletion = () =>
      Promise.resolve({
        content: null,
        toolCalls: [],
        usage: { completionTokens: 0, promptTokens: 100 },
      });

    const pass = new CrossFilePass(llm, createMockLogger());
    const result = await pass.execute(buildContext(), new Map());

    expect(result.findings).toHaveLength(0);
  });
});

describe("CrossFilePass catalog findings", () => {
  async function runCrossFile(
    ruleId: string,
    warn = vi.fn(),
  ): Promise<PassResult["findings"]> {
    const llm = createMockLlmClient({
      defaultContent: JSON.stringify({
        findings: [
          {
            category: "security",
            comment: "free text",
            confidence: 0.8,
            file_path: "src/a.ts",
            line_number: 1,
            line_type: "added",
            rule_id: ruleId,
            severity: "critical",
          },
        ],
      }),
    });
    const pass = new CrossFilePass(llm, createMockLogger({ warn }));
    const result = await pass.execute(buildContext(), new Map());
    return result.findings;
  }

  it("builds a cross-file finding from the catalog regardless of what the model claims", async () => {
    const findings = await runCrossFile("R-026");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      category: "architecture",
      comment:
        "This call does not match the current signature or return type of the function it calls.",
      passName: "cross-file",
      ruleId: "R-026",
      severity: "attention",
    });
  });

  it("drops a file-scope rule returned by the cross-file pass", async () => {
    const warn = vi.fn();
    const findings = await runCrossFile("R-013", warn);
    expect(findings).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "scope_mismatch", ruleId: "R-013" }),
      "Dropping finding outside the rule catalog",
    );
  });

  it("drops an id that is not in the catalog", async () => {
    const warn = vi.fn();
    const findings = await runCrossFile("architecture", warn);
    expect(findings).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "unknown_rule",
        ruleId: "architecture",
      }),
      "Dropping finding outside the rule catalog",
    );
  });

  it("keeps valid findings when one finding in the response is malformed", async () => {
    const warn = vi.fn();
    const llm = createMockLlmClient({
      defaultContent: JSON.stringify({
        findings: [
          {
            confidence: 0.8,
            file_path: "src/a.ts",
            line_number: 1,
            line_type: "moved",
            rule_id: "R-026",
          },
          {
            confidence: 0.8,
            file_path: "src/a.ts",
            line_number: 1,
            line_type: "added",
            rule_id: "R-026",
          },
        ],
      }),
    });
    const pass = new CrossFilePass(llm, createMockLogger({ warn }));
    const result = await pass.execute(buildContext(), new Map());
    expect(result.findings.map((f) => f.ruleId)).toEqual(["R-026"]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ pass: "cross-file" }),
      "Dropping malformed finding",
    );
  });
});

describe("CrossFilePass cost ceiling", () => {
  function buildPricedContext(costBudget: CostBudget): ReviewContext {
    return buildContext({
      costBudget,
      reviewConfig: createMockReviewConfig({
        models: {
          premium: null,
          review: OPENROUTER_REVIEW_MODEL,
          triage: OPENROUTER_TRIAGE_MODEL,
        },
        severityThreshold: "info",
      }),
    });
  }

  it("records the cost of the cross-file call on the review cost budget", async () => {
    const llm = createMockLlmClient({
      responses: [
        {
          content: buildCrossFileResponse(1),
          toolCalls: [],
          usage: { completionTokens: 400, promptTokens: 20_000 },
        },
      ],
    });
    const costBudget = new CostBudget(10);
    const pass = new CrossFilePass(llm, createMockLogger());

    await pass.execute(buildPricedContext(costBudget), new Map());

    expect(costBudget.spent).toBeGreaterThan(0);
  });

  it("skips the cross-file call when the budget is exhausted", async () => {
    const llm = createMockLlmClient({
      defaultContent: buildCrossFileResponse(1),
    });
    const logger = createMockLogger();
    const warn = vi.spyOn(logger, "warn");
    const costBudget = new CostBudget(0);
    const pass = new CrossFilePass(llm, logger);

    const result = await pass.execute(
      buildPricedContext(costBudget),
      new Map(),
    );

    expect(llm.calls.chatCompletion).toHaveLength(0);
    expect(result.findings).toHaveLength(0);
    expect(result.metadata["skipped"]).toBe("cost_ceiling");
    expect(warn).toHaveBeenCalled();
  });
});
