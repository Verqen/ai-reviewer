import { describe, expect, it } from "vitest";

import type { IDocProvider } from "~/domain/ports/doc-provider.port";
import type { PassResult, ReviewContext } from "~/domain/types/pipeline.types";
import { createMockLlmClient } from "~/test-utils/mock-llm-client";
import { createMockLogger } from "~/test-utils/mock-logger";
import { createMockReviewConfig } from "~/test-utils/mock-review-config";

import { FileReviewPass } from "./file-review.pass";

function buildContext(overrides: Partial<ReviewContext> = {}): ReviewContext {
  return {
    diffs: [
      {
        lines: [
          {
            content: "const x = 1;",
            hunkHeader: "@@ -1,1 +1,1 @@",
            newLine: 1,
            type: "added",
          },
        ],
        newPath: "src/utils.ts",
        oldPath: "src/utils.ts",
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
    priorFindingsByFile: {
      addressed: new Map(),
      dismissed: new Map(),
      pending: new Map(),
    },
    projectId: 1,

    reviewConfig: createMockReviewConfig({
      models: {
        premium: "premium-model",
        review: "review-model",
        triage: "triage-model",
      },
      severityThreshold: "info",
    }),

    reviewRunId: "run-1",
    toolCallCache: new Map<string, Promise<string>>(),
    versions: { baseSha: "base", headSha: "head", startSha: "start" },
    ...overrides,
  };
}

function buildFileReviewResponse(
  count = 1,
  severity = "warning",
  filePath = "src/utils.ts",
): string {
  const findings = Array.from({ length: count }, (_, i) => ({
    category: "bug",
    comment: `Issue ${i + 1}`,
    confidence: 0.9,
    end_line: null,
    file_path: filePath,
    line_number: 1,
    line_type: "added",
    severity,
    suggestion: null,
  }));
  return JSON.stringify({ findings });
}

const DEFAULT_PHASE_A_ANALYSIS = "## Analysis\nRisk on L1 (added).";

function createTwoPhaseMockLlm(
  phaseBContent: string,
  phaseAAnalysis = DEFAULT_PHASE_A_ANALYSIS,
): ReturnType<typeof createMockLlmClient> {
  return createMockLlmClient({
    responses: [
      {
        content: phaseAAnalysis,
        toolCalls: [],
        usage: { completionTokens: 5, promptTokens: 10 },
      },
      {
        content: phaseBContent,
        toolCalls: [],
        usage: { completionTokens: 10, promptTokens: 20 },
      },
    ],
  });
}

describe("FileReviewPass", () => {
  it("returns findings from LLM response", async () => {
    const llm = createTwoPhaseMockLlm(buildFileReviewResponse(2));
    const pass = new FileReviewPass(llm, createMockLogger());
    const result = await pass.execute(buildContext(), new Map());

    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]?.severity).toBe("warning");
    expect(result.findings[0]?.passName).toBe("file-review");
    const [firstCall] = llm.calls.chatCompletionWithTools;
    expect(firstCall?.[2]?.maxToolRounds).toBe(3);
    expect(llm.calls.chatCompletion).toHaveLength(1);
    expect(llm.calls.chatCompletion[0]?.[1]?.responseSchema).toBeDefined();
  });
  it("moves prose suggestion into comment and clears suggestion", async () => {
    const llm = createTwoPhaseMockLlm(
      JSON.stringify({
        findings: [
          {
            category: "bug",
            comment: "Original comment",
            confidence: 0.9,
            file_path: "src/utils.ts",
            line_number: 1,
            line_type: "added",
            severity: "warning",
            suggestion:
              "Either remove the injector creation or export the service from the module",
          },
        ],
      }),
    );
    const pass = new FileReviewPass(llm, createMockLogger());
    const result = await pass.execute(buildContext(), new Map());
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.suggestion).toBeUndefined();
    expect(result.findings[0]?.comment).toContain("Original comment");
    expect(result.findings[0]?.comment).toContain(
      "Either remove the injector creation",
    );
  });

  it("keeps empty-string suggestion for deletion-only apply block", async () => {
    const llm = createTwoPhaseMockLlm(
      JSON.stringify({
        findings: [
          {
            category: "bug",
            comment: "Delete redundant line",
            confidence: 0.9,
            file_path: "src/utils.ts",
            line_number: 1,
            line_type: "added",
            original_snippet: "const x = 1;",
            severity: "warning",
            suggestion: "   ",
          },
        ],
      }),
    );
    const pass = new FileReviewPass(llm, createMockLogger());
    const result = await pass.execute(buildContext(), new Map());
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.suggestion).toBe("");
  });

  it("reviews all files (no triage filtering)", async () => {
    const llm = createTwoPhaseMockLlm(buildFileReviewResponse(1));
    const pass = new FileReviewPass(llm, createMockLogger());
    const result = await pass.execute(buildContext(), new Map());

    expect(result.findings).toHaveLength(1);
  });

  it("runs file-review when all triage batches fail parsing", async () => {
    const llm = createTwoPhaseMockLlm(buildFileReviewResponse(1));
    const pass = new FileReviewPass(llm, createMockLogger());

    const priorResults = new Map<string, PassResult>([
      [
        "triage",
        {
          findings: [],
          metadata: {
            decisions: [
              {
                filePath: "src/utils.ts",
                hunkHeader: "@@ -1,1 +1,1 @@",
                verdict: "needs-review",
              },
            ],
            parseFailures: 1,
            totalBatches: 1,
            triageSkipRate: 0,
            trivialHunkCount: 0,
            trivialKeys: new Set<string>(),
          },
          tokenUsage: { completionTokens: 0, promptTokens: 0 },
        },
      ],
    ]);

    const result = await pass.execute(buildContext(), priorResults);

    expect(llm.calls.chatCompletionWithTools).toHaveLength(1);
    expect(llm.calls.chatCompletion).toHaveLength(1);
    expect(result.metadata["skipped"]).not.toBe("triage_unreliable");
    expect(result.findings).toHaveLength(1);
  });

  it("skips file with explicit warning when LLM tool-loop exhausts and returns null content", async () => {
    const llm = createMockLlmClient();
    llm.chatCompletionWithTools = () =>
      Promise.resolve({
        content: null,
        toolCalls: [],
        usage: { completionTokens: 0, promptTokens: 100 },
      });

    const pass = new FileReviewPass(llm, createMockLogger());
    const result = await pass.execute(buildContext(), new Map());

    expect(result.findings).toHaveLength(0);
  });

  it("returns empty findings when no files to review", async () => {
    const llm = createMockLlmClient();
    const pass = new FileReviewPass(llm, createMockLogger());
    const context = buildContext({ diffs: [] });

    const result = await pass.execute(context, new Map());
    expect(result.findings).toHaveLength(0);
    expect(llm.calls.chatCompletion).toHaveLength(0);
  });

  it("skips file and continues on individual file failure", async () => {
    let withToolsRound = 0;
    const successResponse = buildFileReviewResponse(
      1,
      "warning",
      "src/file2.ts",
    );
    const llm = createMockLlmClient();
    llm.chatCompletionWithTools = () => {
      withToolsRound++;
      if (withToolsRound === 1) return Promise.reject(new Error("LLM timeout"));
      return Promise.resolve({
        content: DEFAULT_PHASE_A_ANALYSIS,
        toolCalls: [],
        usage: { completionTokens: 10, promptTokens: 5 },
      });
    };
    llm.chatCompletion = () =>
      Promise.resolve({
        content: successResponse,
        toolCalls: [],
        usage: { completionTokens: 10, promptTokens: 5 },
      });

    const pass = new FileReviewPass(llm, createMockLogger());
    const context = buildContext({
      diffs: [
        {
          lines: [
            { content: "a", hunkHeader: "@@", newLine: 1, type: "added" },
          ],
          newPath: "src/file1.ts",
          oldPath: "src/file1.ts",
        },
        {
          lines: [
            { content: "b", hunkHeader: "@@", newLine: 1, type: "added" },
          ],
          newPath: "src/file2.ts",
          oldPath: "src/file2.ts",
        },
      ],
    });

    const result = await pass.execute(context, new Map());
    expect(result.findings).toHaveLength(1);
  });

  it("puts project rules into system blocks and path rules into user prompt", async () => {
    const llm = createTwoPhaseMockLlm(buildFileReviewResponse(1));
    const pass = new FileReviewPass(llm, createMockLogger());

    await pass.execute(
      buildContext({
        reviewConfig: createMockReviewConfig({
          models: {
            premium: "premium-model",
            review: "review-model",
            triage: "triage-model",
          },
          pathRules: [
            { extraRules: "Global fallback REVIEW", path: "**" },
            { extraRules: "Only for src", path: "src/**" },
          ],
          severityThreshold: "info",
        }),
      }),
      new Map(),
    );

    const [firstCall] = llm.calls.chatCompletionWithTools;
    const systemMessage = firstCall?.[0]?.find(
      (message) => message.role === "system",
    );
    const userMessage = firstCall?.[0]?.find(
      (message) => message.role === "user",
    );
    const systemText = Array.isArray(systemMessage?.content)
      ? systemMessage.content.map((b) => b.text).join("\n")
      : (systemMessage?.content ?? "");

    expect(systemText).toContain("Global fallback REVIEW");
    expect(systemText).toContain("Project rules:");
    expect(systemText).not.toContain("Only for src");
    expect(userMessage?.content).toContain("Only for src");
    expect(userMessage?.content).toContain("Path rules:");
    expect(userMessage?.content).not.toContain("Allowable anchors");
    const extractionUser = llm.calls.chatCompletion[0]?.[0]?.find(
      (message) => message.role === "user",
    );
    expect(extractionUser?.content).toContain("Allowable anchors");
  });

  it("omits cache_control when prefix is too small for Claude model", async () => {
    const llm = createTwoPhaseMockLlm(buildFileReviewResponse(1));
    const pass = new FileReviewPass(llm, createMockLogger());
    const result = await pass.execute(
      buildContext({
        reviewConfig: createMockReviewConfig({
          models: {
            premium: "anthropic/claude-opus-4",
            review: "anthropic/claude-opus-4",
            triage: "anthropic/claude-opus-4",
          },
          severityThreshold: "info",
        }),
      }),
      new Map(),
    );
    expect(result.findings).toHaveLength(1);
    const [firstCall] = llm.calls.chatCompletionWithTools;
    const systemMessage = firstCall?.[0]?.find(
      (message) => message.role === "system",
    );
    const blocks = systemMessage?.content as Array<{
      cacheControl?: { ttl: string; type: string };
      text: string;
    }>;
    expect(blocks[0]?.cacheControl).toBeUndefined();
  });

  it("excludes codebase tools from LLM call when overlayView is absent", async () => {
    const llm = createTwoPhaseMockLlm(buildFileReviewResponse(1));
    const pass = new FileReviewPass(llm, createMockLogger());
    await pass.execute(buildContext({ overlayView: undefined }), new Map());
    const [firstCall] = llm.calls.chatCompletionWithTools;
    const tools = firstCall?.[1] ?? [];
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("read_file");
    expect(names).not.toContain("search_content");
    expect(names).not.toContain("list_files");
  });

  it("excludes codebase tools on small diffs even when overlayView is set (avoids tool-loop exhaustion)", async () => {
    const llm = createTwoPhaseMockLlm(buildFileReviewResponse(1));
    const pass = new FileReviewPass(llm, createMockLogger());
    const overlayView = {
      createToolExecutor: () => () => Promise.resolve(""),
      readFile: () => Promise.resolve(""),
      readFileAtBaseline: () => Promise.resolve(""),
      searchContent: () => Promise.resolve(""),
    };
    // Default buildContext provides a 1-line diff (well below the threshold)
    await pass.execute(buildContext({ overlayView }), new Map());
    const [firstCall] = llm.calls.chatCompletionWithTools;
    const tools = firstCall?.[1] ?? [];
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("read_file");
    expect(names).not.toContain("search_content");
    expect(names).not.toContain("list_files");
    expect(names).not.toContain("diff_hunk");
  });

  it("includes codebase tools on diffs above the threshold", async () => {
    const llm = createTwoPhaseMockLlm(buildFileReviewResponse(1));
    const pass = new FileReviewPass(llm, createMockLogger());
    const overlayView = {
      createToolExecutor: () => () => Promise.resolve(""),
      readFile: () => Promise.resolve(""),
      readFileAtBaseline: () => Promise.resolve(""),
      searchContent: () => Promise.resolve(""),
    };
    const largeDiffContext = buildContext({
      diffs: [
        {
          lines: Array.from({ length: 12 }, (_, i) => ({
            content: `const x${String(i)} = ${String(i)};`,
            hunkHeader: "@@ -1,12 +1,12 @@",
            newLine: i + 1,
            type: "added" as const,
          })),
          newPath: "src/utils.ts",
          oldPath: "src/utils.ts",
        },
      ],
      overlayView,
    });
    await pass.execute(largeDiffContext, new Map());
    const [firstCall] = llm.calls.chatCompletionWithTools;
    const tools = firstCall?.[1] ?? [];
    const names = tools.map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).toContain("diff_hunk");
  });

  it("embeds architecture snapshot into cacheable system block", async () => {
    const longSnapshot = "x".repeat(20000);
    const llm = createTwoPhaseMockLlm(buildFileReviewResponse(1));
    const pass = new FileReviewPass(llm, createMockLogger());
    await pass.execute(
      buildContext({
        architectureSnapshot: longSnapshot,
        reviewConfig: createMockReviewConfig({
          models: {
            premium: "anthropic/claude-sonnet-4-5",
            review: "anthropic/claude-sonnet-4-5",
            triage: "anthropic/claude-sonnet-4-5",
          },
          severityThreshold: "info",
        }),
      }),
      new Map(),
    );
    const [firstCall] = llm.calls.chatCompletionWithTools;
    const systemMessage = firstCall?.[0]?.find(
      (message) => message.role === "system",
    );
    expect(Array.isArray(systemMessage?.content)).toBe(true);
    const blocks = systemMessage?.content as Array<{
      cacheControl?: { ttl: string; type: string };
      text: string;
    }>;
    expect(blocks[0]?.cacheControl?.type).toBe("ephemeral");
    expect(blocks[0]?.cacheControl?.ttl).toBe("1h");
    expect(blocks[0]?.text).toContain("<architecture_snapshot>");
    expect(blocks[0]?.text).toContain(longSnapshot.slice(0, 100));
  });

  it("omits architecture snapshot from system prompt for triage-only (truncated) diffs", async () => {
    const longSnapshot = "ARCHITECTURE_SNAPSHOT_MARKER_X".repeat(500);
    const hugeLines = Array.from({ length: 1200 }, (_, i) => ({
      content: `const variable${i} = ${i};`,
      hunkHeader: "@@ -1,1200 +1,1200 @@",
      newLine: i + 1,
      type: "added" as const,
    }));
    const llm = createTwoPhaseMockLlm(buildFileReviewResponse(1));
    const pass = new FileReviewPass(llm, createMockLogger());

    await pass.execute(
      buildContext({
        architectureSnapshot: longSnapshot,
        diffs: [
          {
            lines: hugeLines,
            newPath: "src/huge.ts",
            oldPath: "src/huge.ts",
          },
        ],
      }),
      new Map(),
    );

    const [firstCall] = llm.calls.chatCompletionWithTools;
    const systemMessage = firstCall?.[0]?.find(
      (message) => message.role === "system",
    );
    const systemText = Array.isArray(systemMessage?.content)
      ? systemMessage.content.map((b) => b.text).join("\n")
      : (systemMessage?.content ?? "");

    expect(systemText).not.toContain("ARCHITECTURE_SNAPSHOT_MARKER_X");
    expect(systemText).not.toContain("<architecture_snapshot>");
  });

  it("drops findings whose file_path is not in the diff (off-diff hard-filter)", async () => {
    const offDiffResponse = JSON.stringify({
      findings: [
        {
          category: "bug",
          comment: "Hallucinated path",
          confidence: 0.9,
          end_line: null,
          file_path: "apps/example-app/foo.ts",
          line_number: 1,
          line_type: "added",
          severity: "critical",
          suggestion: null,
        },
        {
          category: "bug",
          comment: "Legit in-diff finding",
          confidence: 0.9,
          end_line: null,
          file_path: "src/utils.ts",
          line_number: 1,
          line_type: "added",
          severity: "warning",
          suggestion: null,
        },
      ],
    });
    const llm = createTwoPhaseMockLlm(offDiffResponse);
    const warnCalls: unknown[][] = [];
    const logger = createMockLogger();
    logger.warn = (...args: unknown[]): void => {
      warnCalls.push(args);
    };
    const pass = new FileReviewPass(llm, logger);
    const result = await pass.execute(buildContext(), new Map());

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.filePath).toBe("src/utils.ts");
    expect(
      warnCalls.some((args) => {
        const meta = args[0] as { off_diff_path?: string } | undefined;
        return meta?.off_diff_path === "apps/example-app/foo.ts";
      }),
    ).toBe(true);
  });
  it("keeps finding when LLM returns oldPath for renamed file diff", async () => {
    const llm = createTwoPhaseMockLlm(
      JSON.stringify({
        findings: [
          {
            category: "bug",
            comment: "Rename-safe path match",
            confidence: 0.9,
            end_line: null,
            file_path: "src/old-name.ts",
            line_number: 1,
            line_type: "added",
            severity: "warning",
            suggestion: null,
          },
        ],
      }),
    );
    const pass = new FileReviewPass(llm, createMockLogger());
    const result = await pass.execute(
      buildContext({
        diffs: [
          {
            lines: [
              {
                content: "export const value = 1;",
                hunkHeader: "@@ -1,1 +1,1 @@",
                newLine: 1,
                type: "added",
              },
            ],
            newPath: "src/new-name.ts",
            oldPath: "src/old-name.ts",
          },
        ],
      }),
      new Map(),
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.filePath).toBe("src/old-name.ts");
  });

  it("drops findings with line_number outside current hunk", async () => {
    const llm = createTwoPhaseMockLlm(
      JSON.stringify({
        findings: [
          {
            category: "bug",
            comment: "Outside hunk",
            confidence: 0.9,
            end_line: null,
            file_path: "src/utils.ts",
            line_number: 999,
            line_type: "added",
            severity: "warning",
            suggestion: null,
          },
          {
            category: "bug",
            comment: "Inside hunk",
            confidence: 0.9,
            end_line: null,
            file_path: "src/utils.ts",
            line_number: 1,
            line_type: "added",
            severity: "warning",
            suggestion: null,
          },
        ],
      }),
    );
    const warnCalls: unknown[][] = [];
    const logger = createMockLogger();
    logger.warn = (...args: unknown[]): void => {
      warnCalls.push(args);
    };
    const pass = new FileReviewPass(llm, logger);
    const result = await pass.execute(buildContext(), new Map());
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.comment).toContain("Inside hunk");
    expect(
      warnCalls.some((args) => {
        const meta = args[0] as { reason?: string } | undefined;
        return meta?.reason === "line_number_not_in_hunk";
      }),
    ).toBe(true);
  });

  it("drops findings when line_type does not match actual diff line type", async () => {
    const llm = createTwoPhaseMockLlm(
      JSON.stringify({
        findings: [
          {
            category: "bug",
            comment: "Wrong line type",
            confidence: 0.9,
            end_line: null,
            file_path: "src/utils.ts",
            line_number: 1,
            line_type: "removed",
            severity: "warning",
            suggestion: null,
          },
        ],
      }),
    );
    const pass = new FileReviewPass(llm, createMockLogger());
    const result = await pass.execute(buildContext(), new Map());
    expect(result.findings).toHaveLength(0);
  });

  it("drops findings when end_line range crosses multiple hunks", async () => {
    const llm = createTwoPhaseMockLlm(
      JSON.stringify({
        findings: [
          {
            category: "bug",
            comment: "Cross-hunk range",
            confidence: 0.9,
            end_line: 10,
            file_path: "src/utils.ts",
            line_number: 1,
            line_type: "added",
            severity: "warning",
            suggestion: null,
          },
        ],
      }),
    );
    const pass = new FileReviewPass(llm, createMockLogger());
    const result = await pass.execute(
      buildContext({
        diffs: [
          {
            lines: [
              {
                content: "const x = 1;",
                hunkHeader: "@@ -1,1 +1,1 @@",
                newLine: 1,
                type: "added",
              },
              {
                content: "const y = 2;",
                hunkHeader: "@@ -10,1 +10,1 @@",
                newLine: 10,
                type: "added",
              },
            ],
            newPath: "src/utils.ts",
            oldPath: "src/utils.ts",
          },
        ],
      }),
      new Map(),
    );
    expect(result.findings).toHaveLength(0);
  });

  it("drops missing-file import findings without verified_repo_path marker", async () => {
    const llm = createTwoPhaseMockLlm(
      JSON.stringify({
        findings: [
          {
            category: "bug",
            comment:
              "Imports a file that does not exist './user/user.router.ts'. File not found in the repository.",
            confidence: 0.9,
            file_path: "src/utils.ts",
            line_number: 1,
            line_type: "added",
            severity: "warning",
            suggestion: null,
          },
        ],
      }),
    );
    const pass = new FileReviewPass(llm, createMockLogger());
    const result = await pass.execute(buildContext(), new Map());
    expect(result.findings).toHaveLength(0);
  });

  it("keeps missing-file import findings with verified_repo_path marker", async () => {
    const llm = createTwoPhaseMockLlm(
      JSON.stringify({
        findings: [
          {
            category: "bug",
            comment:
              "Imports a file that does not exist './user/user.router.ts'. [verified_repo_path: src/user/user.router.ts]",
            confidence: 0.9,
            file_path: "src/utils.ts",
            line_number: 1,
            line_type: "added",
            severity: "warning",
            suggestion: null,
          },
        ],
      }),
    );
    const pass = new FileReviewPass(llm, createMockLogger());
    const result = await pass.execute(buildContext(), new Map());
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.comment).not.toContain("[verified_repo_path:");
  });

  it("uses doc_query tool and skips eager docs when docs tool is available", async () => {
    const docProvider: IDocProvider = {
      queryDocs: () => Promise.resolve("react docs"),
      resolveLibrary: () =>
        Promise.resolve({
          description: "React",
          id: "react-lib",
          name: "react",
          snippetCount: 1,
        }),
    };
    const llm = createTwoPhaseMockLlm(buildFileReviewResponse(1));
    const pass = new FileReviewPass(llm, createMockLogger(), docProvider);
    await pass.execute(
      buildContext({
        diffs: [
          {
            lines: [
              {
                content: 'import { useMemo } from "react";',
                hunkHeader: "@@ -1,1 +1,1 @@",
                newLine: 1,
                type: "added",
              },
            ],
            newPath: "src/react-file.ts",
            oldPath: "src/react-file.ts",
          },
        ],
      }),
      new Map(),
    );
    const [firstCall] = llm.calls.chatCompletionWithTools;
    const tools = firstCall?.[1]?.map((tool) => tool.name) ?? [];
    const userMessage = firstCall?.[0]?.find(
      (message) => message.role === "user",
    );
    expect(tools).toContain("query_library_docs");
    expect(userMessage?.content).not.toContain("--- Library Documentation ---");
  });

  it("falls back to eager docs for triage-only files where doc_query is disabled", async () => {
    let queryDocsCalls = 0;
    const docProvider: IDocProvider = {
      queryDocs: () => {
        queryDocsCalls += 1;
        return Promise.resolve("react docs");
      },
      resolveLibrary: () =>
        Promise.resolve({
          description: "React",
          id: "react-lib",
          name: "react",
          snippetCount: 1,
        }),
    };
    const hugeLines = Array.from({ length: 1200 }, (_, index) => ({
      content:
        index === 0
          ? 'import { useMemo } from "react";'
          : `const value${index} = ${index};`,
      hunkHeader: "@@ -1,1200 +1,1200 @@",
      newLine: index + 1,
      type: "added" as const,
    }));
    const llm = createTwoPhaseMockLlm(
      buildFileReviewResponse(1, "warning", "src/huge-react.ts"),
    );
    const pass = new FileReviewPass(llm, createMockLogger(), docProvider);
    await pass.execute(
      buildContext({
        diffs: [
          {
            lines: hugeLines,
            newPath: "src/huge-react.ts",
            oldPath: "src/huge-react.ts",
          },
        ],
      }),
      new Map(),
    );
    const [firstCall] = llm.calls.chatCompletionWithTools;
    const tools = firstCall?.[1]?.map((tool) => tool.name) ?? [];
    const userMessage = firstCall?.[0]?.find(
      (message) => message.role === "user",
    );
    expect(tools).not.toContain("doc_query");
    expect(userMessage?.content).toContain("--- Library Documentation ---");
    expect(queryDocsCalls).toBeGreaterThan(0);
  });
});
