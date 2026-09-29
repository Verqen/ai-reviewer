import { describe, expect, it } from "vitest";

import type { IDismissedPatternRepository } from "~/domain/ports/dismissed-pattern.repository.port";
import type { PassResult, ReviewContext } from "~/domain/types/pipeline.types";
import type { Finding, ReviewFinding } from "~/domain/types/review.types";
import { AggregationPass } from "~/pipeline/passes/aggregation.pass";
import {
  buildPullRequestSummaryHeading,
  buildReviewedFindings,
  selectPriorThreadsToResolve,
  type PriorThreadRef,
} from "~/review/github-pr-review";
import { createMockLogger } from "~/test-utils/mock-logger";
import { createMockReviewConfig } from "~/test-utils/mock-review-config";

describe("buildPullRequestSummaryHeading", () => {
  it("names the check without any score", () => {
    const heading = buildPullRequestSummaryHeading({
      partial: false,
      incremental: false,
      reviewedFileCount: 3,
    });
    expect(heading).toBe("## AI Reviewer check");
    expect(heading).not.toMatch(/score|grade|\/100/i);
  });

  it("names the check with the given product name", () => {
    const heading = buildPullRequestSummaryHeading({
      partial: false,
      incremental: false,
      reviewedFileCount: 3,
      productName: "Acme",
    });
    expect(heading).toBe("## Acme check");
  });

  it("uses the default name for a blank product name", () => {
    expect(
      buildPullRequestSummaryHeading({
        partial: false,
        incremental: false,
        reviewedFileCount: 1,
        productName: "  ",
      }),
    ).toBe("## AI Reviewer check");
  });

  it("adds the partial and incremental notes", () => {
    const heading = buildPullRequestSummaryHeading({
      partial: true,
      incremental: true,
      reviewedFileCount: 2,
    });
    expect(heading).toContain("Cross-file analysis was skipped for this run.");
    expect(heading).toContain(
      "only the 2 file(s) changed since the last review were re-analyzed",
    );
  });
});

function buildThread(overrides: Partial<PriorThreadRef> = {}): PriorThreadRef {
  return {
    filePath: "src/a.ts",
    hostDiscussionId: "thread-1",
    line: 10,
    lineType: "added",
    ruleId: "R-014",
    severity: "attention",
    ...overrides,
  };
}

function buildFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    category: "correctness",
    comment: "text",
    confidence: 0.9,
    filePath: "src/a.ts",
    lineNumber: 10,
    lineType: "added",
    model: "test-model",
    passName: "file-review",
    ruleId: "R-014",
    severity: "attention",
    ...overrides,
  };
}

describe("selectPriorThreadsToResolve", () => {
  const reviewed = new Set(["src/a.ts"]);

  it("resolves a catalog-rule thread whose finding is gone", () => {
    const thread = buildThread();
    expect(selectPriorThreadsToResolve([thread], reviewed, [])).toEqual([
      thread,
    ]);
  });

  it("keeps a thread whose finding is still present", () => {
    expect(
      selectPriorThreadsToResolve([buildThread()], reviewed, [
        buildFinding({ lineNumber: 12 }),
      ]),
    ).toEqual([]);
  });

  it("never resolves a legacy thread without a rule id", () => {
    expect(
      selectPriorThreadsToResolve(
        [buildThread({ ruleId: null })],
        reviewed,
        [],
      ),
    ).toEqual([]);
  });

  it("leaves threads on files that were not reviewed", () => {
    expect(
      selectPriorThreadsToResolve(
        [buildThread({ filePath: "src/b.ts" })],
        reviewed,
        [],
      ),
    ).toEqual([]);
  });
});

describe("buildReviewedFindings", () => {
  const noDismissedPatterns: IDismissedPatternRepository = {
    create: () => Promise.reject(new Error("not implemented")),
    findByProject: () => Promise.resolve([]),
    findByRule: () => Promise.resolve(undefined),
    incrementOccurrence: () => Promise.resolve(),
  };

  function buildContext(pending: ReviewFinding[]): ReviewContext {
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
        title: "Test PR",
      },
      previousFindings: [],
      priorFindingsByFile: {
        addressed: new Map(),
        dismissed: new Map(),
        pending: new Map(
          pending.map((finding) => [finding.filePath, [finding]]),
        ),
      },
      projectId: 1,
      reviewConfig: createMockReviewConfig({
        inlineMinConfidence: 0.7,
        severityThreshold: "warning",
      }),
      reviewRunId: "run-1",
      toolCallCache: new Map<string, Promise<string>>(),
      versions: { baseSha: "base", headSha: "head", startSha: "start" },
    };
  }

  it("returns every finding that passed the gates, anchored only when newly postable", async () => {
    const passing = buildFinding({ filePath: "src/a.ts", ruleId: "R-013" });
    const lowConfidence = buildFinding({
      confidence: 0.4,
      filePath: "src/b.ts",
      ruleId: "R-014",
      severity: "critical",
    });
    const lowSeverity = buildFinding({
      filePath: "src/c.ts",
      ruleId: "R-022",
      severity: "info",
    });
    const alreadyOpen = buildFinding({ filePath: "src/d.ts", ruleId: "R-013" });
    const pass = new AggregationPass(
      noDismissedPatterns,
      createMockLogger(),
      3,
    );
    const output = await pass.execute(
      buildContext([
        {
          ...alreadyOpen,
          id: "open-1",
          resolution: "pending",
          reviewRunId: "old-run",
        },
      ]),
      new Map<string, PassResult>([
        [
          "file-review",
          {
            findings: [passing, lowConfidence, lowSeverity, alreadyOpen],
            metadata: {},
            tokenUsage: { completionTokens: 0, promptTokens: 0 },
          },
        ],
      ]),
    );

    const reviewed = buildReviewedFindings(
      output.metadata,
      new Map([[passing, { discussionId: "d-1", noteId: "n-1" }]]),
    );

    expect(reviewed).toEqual([
      {
        anchored: true,
        category: "correctness",
        comment: "text",
        filePath: "src/a.ts",
        hostDiscussionId: "d-1",
        hostNoteId: "n-1",
        line: 10,
        lineType: "added",
        ruleId: "R-013",
        severity: "attention",
      },
      {
        anchored: false,
        category: "correctness",
        comment: "text",
        filePath: "src/d.ts",
        hostDiscussionId: null,
        hostNoteId: null,
        line: 10,
        lineType: "added",
        ruleId: "R-013",
        severity: "attention",
      },
    ]);
  });

  it("keeps an open thread whose repeat passed the gates and resolves one whose repeat failed them", async () => {
    const passingRepeat = buildFinding({
      filePath: "src/a.ts",
      lineNumber: 10,
      ruleId: "R-013",
    });
    const failedRepeat = buildFinding({
      confidence: 0.4,
      filePath: "src/b.ts",
      lineNumber: 20,
      ruleId: "R-014",
      severity: "critical",
    });
    const pass = new AggregationPass(
      noDismissedPatterns,
      createMockLogger(),
      3,
    );
    const output = await pass.execute(
      buildContext([]),
      new Map<string, PassResult>([
        [
          "file-review",
          {
            findings: [passingRepeat, failedRepeat],
            metadata: {},
            tokenUsage: { completionTokens: 0, promptTokens: 0 },
          },
        ],
      ]),
    );
    const keptThread = buildThread({
      filePath: "src/a.ts",
      hostDiscussionId: "keep",
      line: 10,
      ruleId: "R-013",
    });
    const staleThread = buildThread({
      filePath: "src/b.ts",
      hostDiscussionId: "resolve",
      line: 20,
      ruleId: "R-014",
    });

    const resolved = selectPriorThreadsToResolve(
      [keptThread, staleThread],
      new Set(["src/a.ts", "src/b.ts"]),
      output.metadata?.acceptedFindings ?? [],
    );

    expect(resolved).toEqual([staleThread]);
  });

  it("returns nothing when the aggregation pass did not run", () => {
    expect(buildReviewedFindings(undefined, new Map())).toEqual([]);
  });
});
