import { describe, expect, it } from "vitest";

import type { DiffLine, ParsedFileDiff } from "~/domain/types/diff.types";
import type { ReviewContext } from "~/domain/types/pipeline.types";
import { createMockLlmClient } from "~/test-utils/mock-llm-client";
import { createMockLogger } from "~/test-utils/mock-logger";
import { createMockReviewConfig } from "~/test-utils/mock-review-config";

import {
  applyTriageFilter,
  extractHunks,
  hunkKey,
  TriagePass,
  type TriagePassMetadata,
} from "./triage.pass";

const HEADER_A = "@@ -1,3 +1,3 @@";
const HEADER_B = "@@ -10,3 +10,3 @@";
const HEADER_C = "@@ -20,3 +20,3 @@";
const HEADER_D = "@@ -30,3 +30,3 @@";
const HEADER_E = "@@ -40,3 +40,3 @@";

function line(
  hunkHeader: string,
  content: string,
  type: DiffLine["type"] = "added",
  newLine = 1,
): DiffLine {
  return { content, hunkHeader, newLine, type };
}

function makeDiff(
  newPath: string,
  lines: DiffLine[],
  oldPath = newPath,
): ParsedFileDiff {
  return { lines, newPath, oldPath };
}

function buildContext(
  diffs: ParsedFileDiff[],
  overrides: Partial<ReviewContext> = {},
): ReviewContext {
  return {
    diffs,
    forcePushCorrelation: undefined,
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
    }),
    reviewRunId: "run-1",
    toolCallCache: new Map(),
    versions: { baseSha: "base", headSha: "head", startSha: "start" },
    ...overrides,
  };
}

describe("extractHunks", () => {
  it("groups lines by hunk header within a single file", () => {
    const diff = makeDiff("src/a.ts", [
      line(HEADER_A, "const a = 1;"),
      line(HEADER_A, "const b = 2;"),
      line(HEADER_B, "const c = 3;"),
    ]);
    const hunks = extractHunks([diff]);

    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.header).toBe(HEADER_A);
    expect(hunks[0]!.lines).toHaveLength(2);
    expect(hunks[1]!.header).toBe(HEADER_B);
    expect(hunks[1]!.lines).toHaveLength(1);
  });

  it("assigns contiguous numeric ids across files", () => {
    const hunks = extractHunks([
      makeDiff("src/a.ts", [line(HEADER_A, "x")]),
      makeDiff("src/b.ts", [line(HEADER_A, "y"), line(HEADER_B, "z")]),
    ]);
    expect(hunks.map((h) => h.id)).toEqual([0, 1, 2]);
  });

  it("renders hunk body with +/-/context prefixes", () => {
    const diff = makeDiff("src/a.ts", [
      line(HEADER_A, "added line", "added"),
      line(HEADER_A, "removed line", "removed"),
      line(HEADER_A, "context line", "context"),
    ]);
    const hunks = extractHunks([diff]);
    expect(hunks[0]!.body).toBe("+added line\n-removed line\n context line");
  });

  it("returns an empty list when no diffs have lines", () => {
    expect(extractHunks([makeDiff("src/a.ts", [])])).toEqual([]);
  });
});

describe("applyTriageFilter", () => {
  it("returns the original diffs when no hunks are trivial", () => {
    const diffs = [makeDiff("src/a.ts", [line(HEADER_A, "x")])];
    expect(applyTriageFilter(diffs, new Set())).toEqual(diffs);
  });

  it("removes lines from trivial hunks but keeps the file when others remain", () => {
    const diff = makeDiff("src/a.ts", [
      line(HEADER_A, "trivial"),
      line(HEADER_B, "real"),
    ]);
    const trivial = new Set([hunkKey("src/a.ts", HEADER_A)]);
    const [filtered] = applyTriageFilter([diff], trivial);

    expect(filtered).toBeDefined();
    expect(filtered!.lines).toHaveLength(1);
    expect(filtered!.lines[0]!.hunkHeader).toBe(HEADER_B);
  });

  it("drops files whose hunks are all trivial", () => {
    const diff = makeDiff("src/a.ts", [
      line(HEADER_A, "a"),
      line(HEADER_B, "b"),
    ]);
    const trivial = new Set([
      hunkKey("src/a.ts", HEADER_A),
      hunkKey("src/a.ts", HEADER_B),
    ]);
    expect(applyTriageFilter([diff], trivial)).toEqual([]);
  });

  it("scopes trivial keys by file path", () => {
    const diffA = makeDiff("src/a.ts", [line(HEADER_A, "a")]);
    const diffB = makeDiff("src/b.ts", [line(HEADER_A, "b")]);
    const trivial = new Set([hunkKey("src/a.ts", HEADER_A)]);
    const result = applyTriageFilter([diffA, diffB], trivial);

    expect(result).toHaveLength(1);
    expect(result[0]!.newPath).toBe("src/b.ts");
  });
});

describe("TriagePass", () => {
  function verdictsResponse(
    verdicts: { hunk_id: number; verdict: "needs-review" | "trivial" }[],
  ): string {
    return JSON.stringify({ results: verdicts });
  }

  it("returns empty metadata when context has no diffs", async () => {
    const llm = createMockLlmClient();
    const pass = new TriagePass(llm, createMockLogger());
    const result = await pass.execute(buildContext([]), new Map());

    expect(result.findings).toEqual([]);
    expect(result.tokenUsage).toEqual({ completionTokens: 0, promptTokens: 0 });
    expect(llm.calls.chatCompletion).toHaveLength(0);
    const meta = result.metadata as unknown as TriagePassMetadata;
    expect(meta.trivialKeys.size).toBe(0);
    expect(meta.triageSkipRate).toBe(0);
  });

  it("calls the triage model from reviewConfig", async () => {
    const llm = createMockLlmClient({
      defaultContent: verdictsResponse([{ hunk_id: 0, verdict: "trivial" }]),
    });
    const pass = new TriagePass(llm, createMockLogger());
    await pass.execute(
      buildContext([makeDiff("src/a.ts", [line(HEADER_A, "x")])]),
      new Map(),
    );

    expect(llm.calls.chatCompletion).toHaveLength(1);
    const [, opts] = llm.calls.chatCompletion[0]!;
    expect(opts?.model).toBe("triage-model");
    expect(opts?.responseSchema).toBeDefined();
  });

  it("marks trivial hunks and computes skip rate within cap", async () => {
    const llm = createMockLlmClient({
      defaultContent: verdictsResponse([
        { hunk_id: 0, verdict: "trivial" },
        { hunk_id: 1, verdict: "needs-review" },
        { hunk_id: 2, verdict: "trivial" },
        { hunk_id: 3, verdict: "needs-review" },
        { hunk_id: 4, verdict: "needs-review" },
      ]),
    });
    const diffs = [
      makeDiff("src/a.ts", [
        line(HEADER_A, "a"),
        line(HEADER_B, "b"),
        line(HEADER_C, "c"),
      ]),
      makeDiff("src/b.ts", [line(HEADER_D, "d"), line(HEADER_E, "e")]),
    ];
    const pass = new TriagePass(llm, createMockLogger());
    const result = await pass.execute(buildContext(diffs), new Map());
    const meta = result.metadata as unknown as TriagePassMetadata;

    expect(meta.trivialKeys.has(hunkKey("src/a.ts", HEADER_A))).toBe(true);
    expect(meta.trivialKeys.has(hunkKey("src/a.ts", HEADER_C))).toBe(true);
    expect(meta.trivialKeys.has(hunkKey("src/a.ts", HEADER_B))).toBe(false);
    expect(meta.triageSkipRate).toBeCloseTo(2 / 5);
    expect(meta.decisions).toHaveLength(5);
  });

  it("caps trivial share to forty percent and demotes overflow to needs-review", async () => {
    const llm = createMockLlmClient({
      defaultContent: verdictsResponse([
        { hunk_id: 0, verdict: "trivial" },
        { hunk_id: 1, verdict: "trivial" },
        { hunk_id: 2, verdict: "trivial" },
        { hunk_id: 3, verdict: "trivial" },
        { hunk_id: 4, verdict: "needs-review" },
      ]),
    });
    const diffs = [
      makeDiff("src/a.ts", [
        line(HEADER_A, "a"),
        line(HEADER_B, "b"),
        line(HEADER_C, "c"),
        line(HEADER_D, "d"),
        line(HEADER_E, "e"),
      ]),
    ];
    const pass = new TriagePass(llm, createMockLogger());
    const result = await pass.execute(buildContext(diffs), new Map());
    const meta = result.metadata as unknown as TriagePassMetadata;
    const decisionByHeader = new Map(
      meta.decisions.map((decision) => [decision.hunkHeader, decision.verdict]),
    );

    expect(meta.trivialKeys.size).toBe(2);
    expect(meta.triageSkipRate).toBeCloseTo(2 / 5);
    expect(decisionByHeader.get(HEADER_A)).toBe("trivial");
    expect(decisionByHeader.get(HEADER_B)).toBe("trivial");
    expect(decisionByHeader.get(HEADER_C)).toBe("needs-review");
    expect(decisionByHeader.get(HEADER_D)).toBe("needs-review");
  });

  it("keeps decisions unchanged when trivial share is exactly forty percent", async () => {
    const llm = createMockLlmClient({
      defaultContent: verdictsResponse([
        { hunk_id: 0, verdict: "trivial" },
        { hunk_id: 1, verdict: "trivial" },
        { hunk_id: 2, verdict: "needs-review" },
        { hunk_id: 3, verdict: "needs-review" },
        { hunk_id: 4, verdict: "needs-review" },
      ]),
    });
    const diffs = [
      makeDiff("src/a.ts", [
        line(HEADER_A, "a"),
        line(HEADER_B, "b"),
        line(HEADER_C, "c"),
        line(HEADER_D, "d"),
        line(HEADER_E, "e"),
      ]),
    ];
    const pass = new TriagePass(llm, createMockLogger());
    const result = await pass.execute(buildContext(diffs), new Map());
    const meta = result.metadata as unknown as TriagePassMetadata;
    const decisionByHeader = new Map(
      meta.decisions.map((decision) => [decision.hunkHeader, decision.verdict]),
    );

    expect(meta.trivialKeys.size).toBe(2);
    expect(meta.triageSkipRate).toBeCloseTo(2 / 5);
    expect(decisionByHeader.get(HEADER_A)).toBe("trivial");
    expect(decisionByHeader.get(HEADER_B)).toBe("trivial");
  });

  it("applies deterministic trivial selection by hunk id order", async () => {
    const llm = createMockLlmClient({
      defaultContent: verdictsResponse([
        { hunk_id: 4, verdict: "trivial" },
        { hunk_id: 3, verdict: "trivial" },
        { hunk_id: 2, verdict: "trivial" },
        { hunk_id: 1, verdict: "trivial" },
        { hunk_id: 0, verdict: "trivial" },
      ]),
    });
    const diffs = [
      makeDiff("src/a.ts", [
        line(HEADER_A, "a"),
        line(HEADER_B, "b"),
        line(HEADER_C, "c"),
        line(HEADER_D, "d"),
        line(HEADER_E, "e"),
      ]),
    ];
    const pass = new TriagePass(llm, createMockLogger());
    const firstResult = await pass.execute(buildContext(diffs), new Map());
    const secondResult = await pass.execute(buildContext(diffs), new Map());
    const firstMeta = firstResult.metadata as unknown as TriagePassMetadata;
    const secondMeta = secondResult.metadata as unknown as TriagePassMetadata;

    expect([...firstMeta.trivialKeys]).toEqual([...secondMeta.trivialKeys]);
    expect(firstMeta.trivialKeys.has(hunkKey("src/a.ts", HEADER_A))).toBe(true);
    expect(firstMeta.trivialKeys.has(hunkKey("src/a.ts", HEADER_B))).toBe(true);
    expect(firstMeta.trivialKeys.has(hunkKey("src/a.ts", HEADER_C))).toBe(
      false,
    );
    expect(firstMeta.triageSkipRate).toBeCloseTo(2 / 5);
  });

  it("falls back to needs-review for every hunk when the LLM rejects the call", async () => {
    const llm: ReturnType<typeof createMockLlmClient> = {
      calls: { chatCompletion: [], chatCompletionWithTools: [] },
      chatCompletion: () => Promise.reject(new Error("network down")),
      chatCompletionWithTools: () => Promise.reject(new Error("unused")),
    };
    const diffs = [makeDiff("src/a.ts", [line(HEADER_A, "x")])];
    const pass = new TriagePass(llm, createMockLogger());
    const result = await pass.execute(buildContext(diffs), new Map());
    const meta = result.metadata as unknown as TriagePassMetadata;

    expect(meta.trivialKeys.size).toBe(0);
    expect(meta.triageSkipRate).toBe(0);
    expect(meta.decisions).toHaveLength(1);
    expect(meta.decisions[0]!.verdict).toBe("needs-review");
  });

  it("falls back to needs-review when the response fails schema validation", async () => {
    const llm = createMockLlmClient({ defaultContent: "not json at all" });
    const diffs = [makeDiff("src/a.ts", [line(HEADER_A, "x")])];
    const pass = new TriagePass(llm, createMockLogger());
    const result = await pass.execute(buildContext(diffs), new Map());
    const meta = result.metadata as unknown as TriagePassMetadata;

    expect(meta.trivialKeys.size).toBe(0);
    expect(meta.decisions[0]!.verdict).toBe("needs-review");
  });

  it("defaults missing hunks to needs-review when the model skips ids", async () => {
    const llm = createMockLlmClient({
      defaultContent: verdictsResponse([{ hunk_id: 0, verdict: "trivial" }]),
    });
    const diffs = [
      makeDiff("src/a.ts", [line(HEADER_A, "a"), line(HEADER_B, "b")]),
    ];
    const pass = new TriagePass(llm, createMockLogger());
    const result = await pass.execute(buildContext(diffs), new Map());
    const meta = result.metadata as unknown as TriagePassMetadata;

    expect(meta.decisions).toHaveLength(2);
    const byHeader = new Map(meta.decisions.map((d) => [d.hunkHeader, d]));
    expect(byHeader.get(HEADER_A)?.verdict).toBe("needs-review");
    expect(byHeader.get(HEADER_B)?.verdict).toBe("needs-review");
  });

  it("ignores duplicate and unknown hunk ids in the response", async () => {
    const llm = createMockLlmClient({
      defaultContent: verdictsResponse([
        { hunk_id: 0, verdict: "trivial" },
        { hunk_id: 0, verdict: "needs-review" },
        { hunk_id: 99, verdict: "trivial" },
      ]),
    });
    const diffs = [makeDiff("src/a.ts", [line(HEADER_A, "x")])];
    const pass = new TriagePass(llm, createMockLogger());
    const result = await pass.execute(buildContext(diffs), new Map());
    const meta = result.metadata as unknown as TriagePassMetadata;

    expect(meta.decisions).toHaveLength(1);
    expect(meta.decisions[0]!.verdict).toBe("needs-review");
    expect(meta.trivialKeys.size).toBe(0);
  });

  it("uses a single LLM call for small input below batch budget", async () => {
    const llm = createMockLlmClient({
      defaultContent: verdictsResponse([{ hunk_id: 0, verdict: "trivial" }]),
    });
    const diffs = [makeDiff("src/a.ts", [line(HEADER_A, "x")])];
    const pass = new TriagePass(llm, createMockLogger());
    await pass.execute(buildContext(diffs), new Map());
    expect(llm.calls.chatCompletion).toHaveLength(1);
  });

  it("splits into multiple batches for large input and merges results", async () => {
    const HEADER_TEMPLATE = (i: number): string => `@@ -${i},1 +${i},1 @@`;
    // Each hunk body ~200 chars; 200 hunks = 40_000 chars ≈ 10_000 tokens, well above TRIAGE_BATCH_PROMPT_TOKEN_BUDGET=6000
    const manyLines = Array.from({ length: 200 }, (_, i) =>
      line(HEADER_TEMPLATE(i), `const x${i} = ${"a".repeat(200)};`),
    );
    const diffs = [makeDiff("src/big.ts", manyLines)];

    let callCount = 0;
    const llm = createMockLlmClient();
    llm.chatCompletion = (_messages, _opts) => {
      callCount++;
      return Promise.resolve({
        content: "{}",
        toolCalls: [],
        usage: { completionTokens: 5, promptTokens: 100 },
      });
    };

    const pass = new TriagePass(llm, createMockLogger());
    const result = await pass.execute(buildContext(diffs), new Map());

    expect(callCount).toBeGreaterThan(1);
    const meta = result.metadata as unknown as TriagePassMetadata;
    expect(meta.decisions).toHaveLength(200);
  });

  it("marks only the failing batch hunks as needs-review, others keep verdicts", async () => {
    const HEADER_1 = "@@ -1,1 +1,1 @@";
    const HEADER_2 = "@@ -2,1 +2,1 @@";
    // Two hunks each ~12_000 chars so combined estimate (~6_200 tokens) exceeds TRIAGE_BATCH_PROMPT_TOKEN_BUDGET=6000
    const diffs = [
      makeDiff("src/a.ts", [
        line(HEADER_1, "a".repeat(12_000)),
        line(HEADER_2, "b".repeat(12_000)),
      ]),
    ];

    let callCount = 0;
    const llm = createMockLlmClient();
    llm.chatCompletion = (messages, _opts) => {
      callCount++;
      const userMsg = messages.find((m) => m.role === "user");
      const content = userMsg?.content ?? "";
      if (typeof content === "string" && content.includes("Hunk 0:")) {
        return Promise.reject(new Error("batch 0 failed"));
      }
      return Promise.resolve({
        content: verdictsResponse([{ hunk_id: 1, verdict: "trivial" }]),
        toolCalls: [],
        usage: { completionTokens: 5, promptTokens: 100 },
      });
    };

    const pass = new TriagePass(llm, createMockLogger());
    const result = await pass.execute(buildContext(diffs), new Map());
    const meta = result.metadata as unknown as TriagePassMetadata;

    expect(callCount).toBeGreaterThan(1);
    const decisionMap = new Map(
      meta.decisions.map((d) => [d.hunkHeader, d.verdict]),
    );
    expect(decisionMap.get(HEADER_1)).toBe("needs-review");
    expect(decisionMap.get(HEADER_2)).toBe("needs-review");
  });

  it("propagates token usage from the LLM response", async () => {
    const llm = createMockLlmClient({
      defaultContent: verdictsResponse([{ hunk_id: 0, verdict: "trivial" }]),
      responses: [
        {
          content: verdictsResponse([{ hunk_id: 0, verdict: "trivial" }]),
          toolCalls: [],
          usage: { completionTokens: 50, promptTokens: 200 },
        },
      ],
    });
    const diffs = [makeDiff("src/a.ts", [line(HEADER_A, "x")])];
    const pass = new TriagePass(llm, createMockLogger());
    const result = await pass.execute(buildContext(diffs), new Map());

    expect(result.tokenUsage).toEqual({
      completionTokens: 50,
      promptTokens: 200,
    });
  });

  it("stores estimated token metrics in triage metadata", async () => {
    const llm = createMockLlmClient({
      defaultContent: verdictsResponse([{ hunk_id: 0, verdict: "trivial" }]),
    });
    const pass = new TriagePass(llm, createMockLogger());
    const result = await pass.execute(
      buildContext([makeDiff("src/a.ts", [line(HEADER_A, "x")])]),
      new Map(),
    );
    const meta = result.metadata as unknown as TriagePassMetadata;
    expect(meta.totalEstimatedPromptTokens).toBeGreaterThan(0);
    expect(meta.avgBatchEstimatedTokens).toBeGreaterThan(0);
  });
});
