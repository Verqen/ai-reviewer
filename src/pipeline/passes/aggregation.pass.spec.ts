import { describe, expect, it } from "vitest";

import type { DismissedPattern } from "~/domain/ports/dismissed-pattern.repository.port";
import type { IDismissedPatternRepository } from "~/domain/ports/dismissed-pattern.repository.port";
import type {
  AggregationResult,
  PassResult,
  ReviewContext,
} from "~/domain/types/pipeline.types";
import type { Finding, ReviewFinding } from "~/domain/types/review.types";
import { createMockLogger } from "~/test-utils/mock-logger";
import { createMockReviewConfig } from "~/test-utils/mock-review-config";

import { AggregationPass } from "./aggregation.pass";

function buildContext(overrides: Partial<ReviewContext> = {}): ReviewContext {
  return {
    diffs: [],
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
    priorFindingsByFile: {
      addressed: new Map(),
      dismissed: new Map(),
      pending: new Map(),
    },
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

function buildFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    category: "correctness",
    comment: "Test issue",
    confidence: 0.9,
    filePath: "src/a.ts",
    lineNumber: 1,
    lineType: "added",
    model: "test",
    passName: "file-review",
    ruleId: "R-013",
    severity: "attention",
    ...overrides,
  };
}

function buildNoopRepo(): IDismissedPatternRepository {
  return {
    create: () => Promise.reject(new Error("not implemented")),
    findByProject: () => Promise.resolve([]),
    findSimilar: () => Promise.resolve(undefined),
    incrementOccurrence: () => Promise.resolve(),
  };
}

function fileReviewResults(findings: Finding[]): Map<string, PassResult> {
  return new Map<string, PassResult>([
    [
      "file-review",
      {
        findings,
        metadata: {},
        tokenUsage: { completionTokens: 0, promptTokens: 0 },
      },
    ],
  ]);
}

function buildPattern(
  overrides: Partial<DismissedPattern> = {},
): DismissedPattern {
  return {
    category: "correctness",
    createdAt: new Date(),
    id: "pattern-1",
    occurrenceCount: 3,
    patternDescription: "p",
    projectId: 1,
    ruleId: "R-013",
    severity: "attention",
    updatedAt: new Date(),
    ...overrides,
  };
}

function repoWithPatterns(
  patterns: DismissedPattern[],
): IDismissedPatternRepository {
  return {
    create: () => Promise.reject(new Error("not implemented")),
    findByProject: () => Promise.resolve(patterns),
    findSimilar: () => Promise.resolve(undefined),
    incrementOccurrence: () => Promise.resolve(),
  };
}

async function runAggregation(
  findings: Finding[],
  patterns: Partial<DismissedPattern>[] = [],
): Promise<AggregationResult> {
  const repo = repoWithPatterns(
    patterns.map((pattern, index) =>
      buildPattern({ id: `pattern-${String(index)}`, ...pattern }),
    ),
  );
  const pass = new AggregationPass(repo, createMockLogger(), 3);
  const result = await pass.execute(
    buildContext(),
    fileReviewResults(findings),
  );
  return result.metadata;
}

describe("AggregationPass", () => {
  it("merges findings from file-review and cross-file passes", async () => {
    const pass = new AggregationPass(buildNoopRepo(), createMockLogger(), 3);

    const fileReviewFinding = buildFinding({
      comment: "File review issue",
      filePath: "src/a.ts",
      lineNumber: 1,
    });
    const crossFileFinding = buildFinding({
      category: "architecture",
      comment: "Cross-file issue",
      filePath: "src/b.ts",
      lineNumber: 5,
      passName: "cross-file",
    });

    const priorResults = new Map<string, PassResult>([
      [
        "file-review",
        {
          findings: [fileReviewFinding],
          metadata: {},
          tokenUsage: { completionTokens: 10, promptTokens: 5 },
        },
      ],
      [
        "cross-file",
        {
          findings: [crossFileFinding],
          metadata: {},
          tokenUsage: { completionTokens: 5, promptTokens: 3 },
        },
      ],
    ]);

    const result = await pass.execute(buildContext(), priorResults);
    const agg = result.metadata;
    expect(agg.allFindings).toHaveLength(2);
  });

  it("filters postableFindings by severity threshold", async () => {
    const pass = new AggregationPass(buildNoopRepo(), createMockLogger(), 3);

    const warning = buildFinding({
      comment: "Warning finding",
      severity: "warning",
    });
    const attention = buildFinding({
      comment: "Attention finding",
      lineNumber: 2,
      severity: "attention",
    });

    const priorResults = new Map<string, PassResult>([
      [
        "file-review",
        {
          findings: [warning, attention],
          metadata: {},
          tokenUsage: { completionTokens: 0, promptTokens: 0 },
        },
      ],
      [
        "cross-file",
        {
          findings: [],
          metadata: {},
          tokenUsage: { completionTokens: 0, promptTokens: 0 },
        },
      ],
    ]);

    const context = buildContext({
      reviewConfig: createMockReviewConfig({
        models: {
          premium: null,
          review: "review-model",
          triage: "triage-model",
        },
        severityThreshold: "attention",
      }),
    });

    const result = await pass.execute(context, priorResults);
    const agg = result.metadata;
    expect(agg.allFindings).toHaveLength(2);
    expect(agg.postableFindings).toHaveLength(1);
    expect(agg.postableFindings[0]?.severity).toBe("attention");
  });

  it("sorts findings by severity desc then file then line", async () => {
    const pass = new AggregationPass(buildNoopRepo(), createMockLogger(), 3);

    const findings = [
      buildFinding({
        comment: "A nitpick",
        filePath: "src/a.ts",
        lineNumber: 10,
        severity: "nitpick",
      }),
      buildFinding({
        comment: "A critical",
        filePath: "src/b.ts",
        lineNumber: 1,
        severity: "critical",
      }),
      buildFinding({
        comment: "An attention",
        filePath: "src/a.ts",
        lineNumber: 4,
        severity: "attention",
      }),
      buildFinding({
        comment: "A warning",
        filePath: "src/a.ts",
        lineNumber: 5,
        severity: "warning",
      }),
    ];

    const priorResults = new Map<string, PassResult>([
      [
        "file-review",
        {
          findings,
          metadata: {},
          tokenUsage: { completionTokens: 0, promptTokens: 0 },
        },
      ],
      [
        "cross-file",
        {
          findings: [],
          metadata: {},
          tokenUsage: { completionTokens: 0, promptTokens: 0 },
        },
      ],
    ]);

    const result = await pass.execute(buildContext(), priorResults);
    const agg = result.metadata;
    expect(agg.allFindings[0]?.severity).toBe("critical");
    expect(agg.allFindings[1]?.severity).toBe("attention");
    expect(agg.allFindings[2]?.severity).toBe("warning");
    expect(agg.allFindings[3]?.severity).toBe("nitpick");
  });

  it("breaks severity ties by file path then line number", async () => {
    const pass = new AggregationPass(buildNoopRepo(), createMockLogger(), 3);

    const findings = [
      buildFinding({
        comment: "b file line 2",
        filePath: "src/b.ts",
        lineNumber: 2,
        severity: "warning",
      }),
      buildFinding({
        comment: "a file line 5",
        filePath: "src/a.ts",
        lineNumber: 5,
        severity: "warning",
      }),
      buildFinding({
        comment: "a file line 2",
        filePath: "src/a.ts",
        lineNumber: 2,
        severity: "warning",
      }),
    ];

    const result = await pass.execute(
      buildContext(),
      fileReviewResults(findings),
    );
    const agg = result.metadata;
    expect(
      agg.allFindings.map((f) => `${f.filePath}:${String(f.lineNumber)}`),
    ).toEqual(["src/a.ts:2", "src/a.ts:5", "src/b.ts:2"]);
  });

  it("exposes the aggregation pass name", () => {
    const pass = new AggregationPass(buildNoopRepo(), createMockLogger(), 3);
    expect(pass.name).toBe("aggregation");
  });

  it("does not repost finding already correlated to the same line+category after force-push", async () => {
    const pass = new AggregationPass(buildNoopRepo(), createMockLogger(), 3);

    const previouslyCorrelated = {
      ...buildFinding({
        category: "security",
        comment: "old wording",
        filePath: "src/cookies.ts",
        lineNumber: 11,
        severity: "critical",
      }),
      hostDiscussionId: "disc-1",
      id: "prior-1",
      resolution: "pending" as const,
      reviewRunId: "run-old",
    };
    const newFinding = buildFinding({
      category: "security",
      comment: "rephrased",
      filePath: "src/cookies.ts",
      lineNumber: 11,
      severity: "critical",
    });

    const priorResults = new Map<string, PassResult>([
      [
        "file-review",
        {
          findings: [newFinding],
          metadata: {},
          tokenUsage: { completionTokens: 0, promptTokens: 0 },
        },
      ],
      [
        "cross-file",
        {
          findings: [],
          metadata: {},
          tokenUsage: { completionTokens: 0, promptTokens: 0 },
        },
      ],
    ]);

    const result = await pass.execute(
      buildContext({
        forcePushCorrelation: {
          addressed: [],
          correlated: [
            {
              finding: { ...previouslyCorrelated, lineNumber: 8 },
              newLineNumber: 11,
            },
          ],
          pending: [],
        },
      }),
      priorResults,
    );
    const agg = result.metadata;
    expect(agg.allFindings).toHaveLength(1);
    expect(agg.postableFindings).toHaveLength(0);
  });

  it("suppresses line-shifted duplicate near correlated line after force-push", async () => {
    const pass = new AggregationPass(buildNoopRepo(), createMockLogger(), 3);
    const previouslyCorrelated = {
      ...buildFinding({
        category: "security",
        comment: "old wording",
        filePath: "src/cookies.ts",
        lineNumber: 14,
        severity: "critical",
      }),
      hostDiscussionId: "disc-2",
      id: "prior-2",
      resolution: "pending" as const,
      reviewRunId: "run-old",
    };
    const shiftedDuplicate = buildFinding({
      category: "security",
      comment: "same issue but line shifted",
      filePath: "src/cookies.ts",
      lineNumber: 18,
      severity: "critical",
    });
    const priorResults = new Map<string, PassResult>([
      [
        "file-review",
        {
          findings: [shiftedDuplicate],
          metadata: {},
          tokenUsage: { completionTokens: 0, promptTokens: 0 },
        },
      ],
      [
        "cross-file",
        {
          findings: [],
          metadata: {},
          tokenUsage: { completionTokens: 0, promptTokens: 0 },
        },
      ],
    ]);
    const result = await pass.execute(
      buildContext({
        forcePushCorrelation: {
          addressed: [],
          correlated: [
            {
              finding: previouslyCorrelated,
              newLineNumber: 16,
            },
          ],
          pending: [],
        },
      }),
      priorResults,
    );
    const agg = result.metadata;
    expect(agg.allFindings).toHaveLength(1);
    expect(agg.postableFindings).toHaveLength(0);
  });

  it("does not repost prior pending finding when LLM paraphrases comment on same line+category", async () => {
    const pass = new AggregationPass(buildNoopRepo(), createMockLogger(), 3);

    const priorFinding = buildFinding({
      category: "security",
      comment: "httpOnly: false → XSS risk",
      filePath: "src/cookies.ts",
      lineNumber: 11,
      severity: "critical",
    });
    const paraphrased = buildFinding({
      category: "security",
      comment:
        "accessToken cookie is accessible to JavaScript — interception risk",
      filePath: "src/cookies.ts",
      lineNumber: 11,
      severity: "critical",
    });

    const priorResults = new Map<string, PassResult>([
      [
        "file-review",
        {
          findings: [paraphrased],
          metadata: {},
          tokenUsage: { completionTokens: 0, promptTokens: 0 },
        },
      ],
      [
        "cross-file",
        {
          findings: [],
          metadata: {},
          tokenUsage: { completionTokens: 0, promptTokens: 0 },
        },
      ],
    ]);

    const result = await pass.execute(
      buildContext({
        priorFindingsByFile: {
          addressed: new Map(),
          dismissed: new Map(),
          pending: new Map<string, ReviewFinding[]>([
            [
              "src/cookies.ts",
              [
                {
                  ...priorFinding,
                  id: "existing",
                  resolution: "pending",
                  reviewRunId: "old-run",
                },
              ],
            ],
          ]),
        },
      }),
      priorResults,
    );
    const agg = result.metadata;
    expect(agg.allFindings).toHaveLength(1);
    expect(agg.postableFindings).toHaveLength(0);
  });

  it("deduplicates finding when only line number changed", async () => {
    const pass = new AggregationPass(buildNoopRepo(), createMockLogger(), 3);

    const priorFinding = buildFinding({
      category: "security",
      comment: "httpOnly: false → XSS risk",
      filePath: "src/cookies.ts",
      lineNumber: 11,
      severity: "critical",
    });
    const shifted = buildFinding({
      category: "security",
      comment: "httpOnly: false → XSS risk",
      filePath: "src/cookies.ts",
      lineNumber: 14,
      severity: "critical",
    });

    const priorResults = new Map<string, PassResult>([
      [
        "file-review",
        {
          findings: [shifted],
          metadata: {},
          tokenUsage: { completionTokens: 0, promptTokens: 0 },
        },
      ],
      [
        "cross-file",
        {
          findings: [],
          metadata: {},
          tokenUsage: { completionTokens: 0, promptTokens: 0 },
        },
      ],
    ]);

    const result = await pass.execute(
      buildContext({
        priorFindingsByFile: {
          addressed: new Map(),
          dismissed: new Map(),
          pending: new Map<string, ReviewFinding[]>([
            [
              "src/cookies.ts",
              [
                {
                  ...priorFinding,
                  id: "existing",
                  lineExcerpt: "secure: false,",
                  resolution: "pending",
                  reviewRunId: "old-run",
                },
              ],
            ],
          ]),
        },
      }),
      priorResults,
    );
    const agg = result.metadata;
    expect(agg.allFindings).toHaveLength(1);
    expect(agg.postableFindings).toHaveLength(0);
  });

  it("does not repost prior pending findings as new inline comments", async () => {
    const pass = new AggregationPass(buildNoopRepo(), createMockLogger(), 3);

    const finding = buildFinding({
      comment: "Duplicate issue",
      filePath: "src/a.ts",
      lineNumber: 1,
    });

    const priorResults = new Map<string, PassResult>([
      [
        "file-review",
        {
          findings: [finding],
          metadata: {},
          tokenUsage: { completionTokens: 0, promptTokens: 0 },
        },
      ],
      [
        "cross-file",
        {
          findings: [],
          metadata: {},
          tokenUsage: { completionTokens: 0, promptTokens: 0 },
        },
      ],
    ]);

    const result = await pass.execute(
      buildContext({
        priorFindingsByFile: {
          addressed: new Map(),
          dismissed: new Map(),
          pending: new Map<string, ReviewFinding[]>([
            [
              "src/a.ts",
              [
                {
                  ...finding,
                  id: "existing",
                  resolution: "pending",
                  reviewRunId: "old-run",
                },
              ],
            ],
          ]),
        },
      }),
      priorResults,
    );
    const agg = result.metadata;
    expect(agg.allFindings).toHaveLength(1);
    expect(agg.postableFindings).toHaveLength(0);
  });

  it("keeps two different rules on the same line", async () => {
    const result = await runAggregation([
      buildFinding({ lineNumber: 5, ruleId: "R-013", severity: "attention" }),
      buildFinding({
        category: "types",
        lineNumber: 5,
        ruleId: "R-022",
        severity: "warning",
      }),
    ]);
    expect(result.allFindings.map((f) => f.ruleId).sort()).toEqual([
      "R-013",
      "R-022",
    ]);
  });

  it("deduplicates the same rule at the same anchor", async () => {
    const result = await runAggregation([
      buildFinding({ lineNumber: 5, passName: "file-review" }),
      buildFinding({ lineNumber: 5, passName: "cross-file" }),
    ]);
    expect(result.allFindings).toHaveLength(1);
  });

  it("never rewrites the catalog text or severity", async () => {
    const input = [1, 2, 3, 4].map((line) =>
      buildFinding({ lineNumber: line }),
    );
    const result = await runAggregation(input);
    expect(new Set(result.allFindings.map((f) => f.comment))).toEqual(
      new Set([input[0]?.comment]),
    );
    expect(result.allFindings.every((f) => f.severity === "attention")).toBe(
      true,
    );
  });

  it("suppresses by rule id and path glob", async () => {
    const result = await runAggregation(
      [
        buildFinding({ filePath: "src/legacy/a.ts" }),
        buildFinding({ filePath: "src/new/a.ts" }),
      ],
      [{ filePathGlob: "src/legacy/**", occurrenceCount: 5, ruleId: "R-013" }],
    );
    expect(result.allFindings.map((f) => f.filePath)).toEqual(["src/new/a.ts"]);
    expect(result.suppressedCount).toBe(1);
  });

  it("ignores a dismissed pattern that has no rule id", async () => {
    const result = await runAggregation(
      [buildFinding({ filePath: "src/legacy/a.ts" })],
      [
        {
          filePathGlob: "src/legacy/**",
          occurrenceCount: 5,
          ruleId: undefined,
        },
      ],
    );
    expect(result.suppressedCount).toBe(0);
  });

  it("does not suppress a finding when the dismissed pattern targets a different rule", async () => {
    const result = await runAggregation(
      [buildFinding()],
      [{ occurrenceCount: 5, ruleId: "R-014" }],
    );
    expect(result.suppressedCount).toBe(0);
  });

  it("does not suppress a matching pattern whose occurrence count is below the threshold", async () => {
    const result = await runAggregation(
      [buildFinding()],
      [{ occurrenceCount: 0, ruleId: "R-013" }],
    );
    expect(result.allFindings).toHaveLength(1);
    expect(result.suppressedCount).toBe(0);
  });

  it("posts a new finding on the same line when the rule differs from the prior pending one", async () => {
    const pass = new AggregationPass(buildNoopRepo(), createMockLogger(), 3);
    const prior = buildFinding({ lineNumber: 1, ruleId: "R-013" });
    const next = buildFinding({
      category: "performance",
      lineNumber: 1,
      ruleId: "R-014",
    });
    const result = await pass.execute(
      buildContext({
        priorFindingsByFile: {
          addressed: new Map(),
          dismissed: new Map(),
          pending: new Map<string, ReviewFinding[]>([
            [
              "src/a.ts",
              [
                {
                  ...prior,
                  id: "existing",
                  resolution: "pending",
                  reviewRunId: "old-run",
                },
              ],
            ],
          ]),
        },
      }),
      fileReviewResults([next]),
    );
    expect(result.metadata.postableFindings).toHaveLength(1);
    expect(result.metadata.postableFindings[0]?.ruleId).toBe("R-014");
  });
});
