import { describe, expect, it } from "vitest";

import type { Finding } from "~/domain/types/review.types";
import {
  buildPullRequestSummaryHeading,
  selectPriorThreadsToResolve,
  type PriorThreadRef,
} from "~/review/github-pr-review";

describe("buildPullRequestSummaryHeading", () => {
  it("names the check without any score", () => {
    const heading = buildPullRequestSummaryHeading({
      partial: false,
      incremental: false,
      reviewedFileCount: 3,
    });
    expect(heading).toBe("## Verqen check");
    expect(heading).not.toMatch(/score|grade|\/100/i);
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
