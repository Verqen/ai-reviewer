import { describe, expect, it } from "vitest";

import type { DismissedPattern } from "~/domain/ports/dismissed-pattern.repository.port";
import type { IDismissedPatternRepository } from "~/domain/ports/dismissed-pattern.repository.port";
import type { PassResult, ReviewContext } from "~/domain/types/pipeline.types";
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
    category: "bug",
    comment: "Test issue",
    confidence: 0.9,
    filePath: "src/a.ts",
    lineNumber: 1,
    lineType: "added",
    model: "test",
    passName: "file-review",
    severity: "warning",
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
    category: "bug",
    createdAt: new Date(),
    id: "pattern-1",
    occurrenceCount: 3,
    patternDescription: "pattern",
    projectId: 1,
    sampleComment: "",
    severity: "warning",
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

  it("deduplicates findings on same file+line with identical normalized comment", async () => {
    const pass = new AggregationPass(buildNoopRepo(), createMockLogger(), 3);

    const f1 = buildFinding({
      comment: "  Duplicate  issue  ",
      filePath: "src/a.ts",
      lineNumber: 1,
      passName: "file-review",
    });
    const f2 = buildFinding({
      comment: "Duplicate issue",
      filePath: "src/a.ts",
      lineNumber: 1,
      passName: "cross-file",
    });

    const priorResults = new Map<string, PassResult>([
      [
        "file-review",
        {
          findings: [f1],
          metadata: {},
          tokenUsage: { completionTokens: 0, promptTokens: 0 },
        },
      ],
      [
        "cross-file",
        {
          findings: [f2],
          metadata: {},
          tokenUsage: { completionTokens: 0, promptTokens: 0 },
        },
      ],
    ]);

    const result = await pass.execute(buildContext(), priorResults);
    const agg = result.metadata;
    expect(agg.allFindings).toHaveLength(1);
  });

  it("keeps highest severity when deduplicating same-line different comments", async () => {
    const pass = new AggregationPass(buildNoopRepo(), createMockLogger(), 3);

    const warning = buildFinding({
      comment: "Warning issue",
      filePath: "src/a.ts",
      lineNumber: 1,
      severity: "warning",
    });
    const critical = buildFinding({
      comment: "Critical issue",
      filePath: "src/a.ts",
      lineNumber: 1,
      severity: "critical",
    });

    const priorResults = new Map<string, PassResult>([
      [
        "file-review",
        {
          findings: [warning, critical],
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
    expect(agg.allFindings).toHaveLength(1);
    expect(agg.allFindings[0]?.severity).toBe("critical");
  });

  it("suppresses findings matching dismissed patterns with occurrence >= threshold", async () => {
    const pattern: DismissedPattern = {
      category: "style",
      createdAt: new Date(),
      id: "p1",
      occurrenceCount: 3,
      patternDescription: "style issue",
      projectId: 1,
      sampleComment: "trailing spaces",
      severity: "nitpick",
      updatedAt: new Date(),
    };

    const repo: IDismissedPatternRepository = {
      create: () => Promise.reject(new Error("not implemented")),
      findByProject: () => Promise.resolve([pattern]),
      findSimilar: () => Promise.resolve(undefined),
      incrementOccurrence: () => Promise.resolve(),
    };

    const pass = new AggregationPass(repo, createMockLogger(), 3);

    const finding = buildFinding({
      category: "style",
      comment: "Avoid trailing spaces here",
      severity: "nitpick",
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

    const result = await pass.execute(buildContext(), priorResults);
    const agg = result.metadata;
    expect(agg.suppressedCount).toBe(1);
    expect(agg.allFindings).toHaveLength(0);
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

  it("keeps the first occurrence of an exact duplicate regardless of a later same-line copy's severity", async () => {
    const pass = new AggregationPass(buildNoopRepo(), createMockLogger(), 3);

    const first = buildFinding({
      comment: "  Duplicate  Issue  ",
      filePath: "src/a.ts",
      lineNumber: 1,
      severity: "info",
    });
    const second = buildFinding({
      comment: "duplicate issue",
      filePath: "src/a.ts",
      lineNumber: 1,
      severity: "critical",
    });

    const result = await pass.execute(
      buildContext(),
      fileReviewResults([first, second]),
    );
    const agg = result.metadata;
    expect(agg.allFindings).toHaveLength(1);
    expect(agg.allFindings[0]?.severity).toBe("info");
  });

  it("keeps the higher-severity finding when a lower-severity different comment lands on the same line", async () => {
    const pass = new AggregationPass(buildNoopRepo(), createMockLogger(), 3);

    const critical = buildFinding({
      comment: "Critical issue",
      filePath: "src/a.ts",
      lineNumber: 1,
      severity: "critical",
    });
    const info = buildFinding({
      comment: "Minor note",
      filePath: "src/a.ts",
      lineNumber: 1,
      severity: "info",
    });

    const result = await pass.execute(
      buildContext(),
      fileReviewResults([critical, info]),
    );
    const agg = result.metadata;
    expect(agg.allFindings).toHaveLength(1);
    expect(agg.allFindings[0]?.severity).toBe("critical");
  });

  it("keeps the first finding when an equal-severity different comment lands on the same line", async () => {
    const pass = new AggregationPass(buildNoopRepo(), createMockLogger(), 3);

    const firstWarning = buildFinding({
      comment: "First warning",
      filePath: "src/a.ts",
      lineNumber: 1,
      severity: "warning",
    });
    const secondWarning = buildFinding({
      comment: "Second warning",
      filePath: "src/a.ts",
      lineNumber: 1,
      severity: "warning",
    });

    const result = await pass.execute(
      buildContext(),
      fileReviewResults([firstWarning, secondWarning]),
    );
    const agg = result.metadata;
    expect(agg.allFindings).toHaveLength(1);
    expect(agg.allFindings[0]?.comment).toBe("First warning");
  });

  it("does not suppress a finding when the dismissed pattern targets a different category", async () => {
    const repo = repoWithPatterns([
      buildPattern({ category: "style", sampleComment: "" }),
    ]);
    const pass = new AggregationPass(repo, createMockLogger(), 3);

    const finding = buildFinding({ category: "bug", comment: "Real bug" });

    const result = await pass.execute(
      buildContext(),
      fileReviewResults([finding]),
    );
    const agg = result.metadata;
    expect(agg.allFindings).toHaveLength(1);
    expect(agg.suppressedCount).toBe(0);
  });

  it("requires all of the first three pattern keywords to be present before suppressing", async () => {
    const repo = repoWithPatterns([
      buildPattern({
        category: "bug",
        sampleComment: "alpha beta gamma delta",
      }),
    ]);
    const pass = new AggregationPass(repo, createMockLogger(), 3);

    const matchesFirstThree = buildFinding({
      category: "bug",
      comment: "alpha beta gamma here",
      lineNumber: 1,
    });
    const matchesOnlyOne = buildFinding({
      category: "bug",
      comment: "alpha only stuff",
      lineNumber: 2,
    });

    const result = await pass.execute(
      buildContext(),
      fileReviewResults([matchesFirstThree, matchesOnlyOne]),
    );
    const agg = result.metadata;
    expect(agg.suppressedCount).toBe(1);
    expect(agg.allFindings).toHaveLength(1);
    expect(agg.allFindings[0]?.comment).toBe("alpha only stuff");
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

  it("does not suppress when the dismissed pattern's file glob excludes the finding's path", async () => {
    const repo = repoWithPatterns([
      buildPattern({
        category: "bug",
        filePathGlob: "src/other/**",
        sampleComment: "",
      }),
    ]);
    const pass = new AggregationPass(repo, createMockLogger(), 3);

    const finding = buildFinding({
      category: "bug",
      comment: "Real bug",
      filePath: "src/a.ts",
    });

    const result = await pass.execute(
      buildContext(),
      fileReviewResults([finding]),
    );
    const agg = result.metadata;
    expect(agg.allFindings).toHaveLength(1);
    expect(agg.suppressedCount).toBe(0);
  });

  it("suppresses a category-only dismissed pattern that has no sample comment", async () => {
    const repo = repoWithPatterns([
      buildPattern({ category: "bug", sampleComment: undefined }),
    ]);
    const pass = new AggregationPass(repo, createMockLogger(), 3);

    const finding = buildFinding({ category: "bug", comment: "Real bug" });

    const result = await pass.execute(
      buildContext(),
      fileReviewResults([finding]),
    );
    const agg = result.metadata;
    expect(agg.suppressedCount).toBe(1);
    expect(agg.allFindings).toHaveLength(0);
  });

  it("does not suppress a matching pattern whose occurrence count is below the threshold", async () => {
    const repo = repoWithPatterns([
      buildPattern({ category: "bug", occurrenceCount: 0, sampleComment: "" }),
    ]);
    const pass = new AggregationPass(repo, createMockLogger(), 3);

    const finding = buildFinding({ category: "bug", comment: "Real bug" });

    const result = await pass.execute(
      buildContext(),
      fileReviewResults([finding]),
    );
    const agg = result.metadata;
    expect(agg.allFindings).toHaveLength(1);
    expect(agg.suppressedCount).toBe(0);
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

  it("posts new finding on same line when category differs from prior pending", async () => {
    const pass = new AggregationPass(buildNoopRepo(), createMockLogger(), 3);

    const priorFinding = buildFinding({
      category: "security",
      comment: "XSS risk",
      filePath: "src/a.ts",
      lineNumber: 1,
      severity: "critical",
    });
    const newCategoryFinding = buildFinding({
      category: "performance",
      comment: "N+1 query",
      filePath: "src/a.ts",
      lineNumber: 1,
      severity: "critical",
    });

    const priorResults = new Map<string, PassResult>([
      [
        "file-review",
        {
          findings: [newCategoryFinding],
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
    expect(agg.postableFindings).toHaveLength(1);
    expect(agg.postableFindings[0]?.category).toBe("performance");
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
});
