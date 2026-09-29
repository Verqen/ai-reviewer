import { describe, expect, it } from "vitest";

import type { CommitReviewFinding } from "~/review/commit-review-finding";
import type {
  CommitReviewBaseline,
  CommitReviewComparison,
} from "~/review/commit-review-comparison";
import {
  buildComparisonSummary,
  compareCommitRun,
  FIRST_RUN_SUMMARY,
} from "~/review/commit-review-comparison";

function current(filePath: string, fingerprint: string): CommitReviewFinding {
  return {
    condition: "c",
    filePath,
    fingerprint,
    line: 1,
    message: "m",
    ruleId: "R-014",
    severity: "attention",
  };
}

const BASELINE: CommitReviewBaseline = {
  catalogVersion: "2026.10.1",
  commitSha: "abcdef1234567890abcdef1234567890abcdef12",
  findings: [
    { filePath: "src/a.ts", fingerprint: "f1", line: 3, ruleId: "R-014" },
    { filePath: "src/gone.ts", fingerprint: "f9", line: 4, ruleId: "R-014" },
  ],
  finishedAt: "2026-09-29T10:15:00.000Z",
  runId: "11111111-1111-4111-8111-111111111111",
};

function comparison(
  overrides: Partial<CommitReviewComparison> = {},
): CommitReviewComparison {
  return {
    baselineCatalogVersion: "2026.10.1",
    baselineCommitSha: BASELINE.commitSha,
    baselineFinishedAt: BASELINE.finishedAt,
    baselineRunId: BASELINE.runId,
    new: 1,
    notComparable: 0,
    persisting: 1,
    resolved: [
      { fileRemoved: true, filePath: "src/gone.ts", line: 4, ruleId: "R-014" },
    ],
    ...overrides,
  };
}

describe("compareCommitRun", () => {
  it("labels each current finding and counts the comparison", () => {
    const kept = current("src/a.ts", "f1");
    const added = current("src/b.ts", "f2");

    const result = compareCommitRun({
      baseline: BASELINE,
      comparableRuleIds: new Set(["R-014"]),
      currentPaths: new Set(["src/a.ts", "src/b.ts"]),
      findings: [kept, added],
      unreviewedPaths: new Set(),
    });

    expect(result.comparison).toEqual(comparison());
    expect(result.labels.get(kept)).toBe("persisting");
    expect(result.labels.get(added)).toBe("new");
  });
});

describe("buildComparisonSummary", () => {
  const sameCatalog = {
    comparableRuleCount: 26,
    currentVersion: "2026.10.1",
    notComparableRuleCount: 0,
  };

  it("names the baseline run, the three counts and each resolved finding", () => {
    const summary = buildComparisonSummary(comparison(), sameCatalog);

    expect(summary).toContain("Comparison with run abcdef1 (2026-09-29)");
    expect(summary).toContain("New: 1 · Persisting: 1 · Resolved: 1");
    expect(summary).toContain("R-014 · src/gone.ts:4 (file removed)");
    expect(summary).not.toContain("Rule catalog changed");
  });

  it("lists at most 100 resolved findings and counts the rest", () => {
    const resolved = Array.from({ length: 101 }, (_, index) => ({
      fileRemoved: false,
      filePath: "src/a.ts",
      line: index + 1,
      ruleId: "R-014",
    }));

    const summary = buildComparisonSummary(
      comparison({ resolved }),
      sameCatalog,
    );

    expect(summary).toContain("R-014 · src/a.ts:100");
    expect(summary).not.toContain("R-014 · src/a.ts:101");
    expect(summary).toContain("and 1 more");
  });

  it("states a catalog change with compared and not comparable rule counts", () => {
    const summary = buildComparisonSummary(comparison(), {
      comparableRuleCount: 25,
      currentVersion: "2026.11.1",
      notComparableRuleCount: 2,
    });

    expect(summary).toContain(
      "Rule catalog changed 2026.10.1 → 2026.11.1: 25 rules compared, 2 not comparable.",
    );
  });

  it("states nothing about uncompared findings when every finding was compared", () => {
    const summary = buildComparisonSummary(comparison(), sameCatalog);

    expect(summary).not.toContain("were not compared");
  });

  it("states how many findings were not compared right after the counts", () => {
    const summary = buildComparisonSummary(
      comparison({ notComparable: 3 }),
      sameCatalog,
    );

    expect(summary).toContain(
      "New: 1 · Persisting: 1 · Resolved: 1\n\n3 findings were not compared: their rule is outside one of the two catalog versions or their file was not fully reviewed in one of the runs.",
    );
  });

  it("says a first run has nothing to compare with", () => {
    expect(FIRST_RUN_SUMMARY).toBe(
      "First run for this repository: there is no earlier result to compare with.",
    );
    expect(FIRST_RUN_SUMMARY).not.toContain("borderline");
  });

  it("states in the caveat that borderline matches can differ between runs", () => {
    const summary = buildComparisonSummary(comparison(), sameCatalog);

    expect(summary).toMatch(
      /The same code can yield a different borderline match between runs, so a single new or resolved match is not by itself proof of a code change\.$/,
    );
  });
});
