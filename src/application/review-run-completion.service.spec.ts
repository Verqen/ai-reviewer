import { describe, expect, it } from "vitest";

import { buildOverviewText } from "./review-run-completion.service";

describe("buildOverviewText", () => {
  it("degraded: no findings", () => {
    const text = buildOverviewText({
      allFindingsCount: 0,
      postableFindingsCount: 0,
      repostedFindingsCount: 0,
      reviewRunId: "run-abc",
      triageDegradation: {
        model: "minimax/m2.7",
        parseFailures: 1,
        totalBatches: 1,
      },
    });

    expect(text).toBe(
      "⚠ AI review degraded: triage parser failed on 1/1 batches (model=minimax/m2.7); file-review found no issues. See logs reviewRunId=run-abc."
    );
  });

  it("degraded: with findings", () => {
    const text = buildOverviewText({
      allFindingsCount: 3,
      postableFindingsCount: 2,
      repostedFindingsCount: 0,
      reviewRunId: "run-abc",
      triageDegradation: {
        model: "minimax/m2.7",
        parseFailures: 1,
        totalBatches: 1,
      },
    });

    expect(text).toBe(
      "⚠ AI review degraded: triage parser failed on 1/1 batches (model=minimax/m2.7). 3 finding(s), 2 posted inline. See logs reviewRunId=run-abc."
    );
  });

  it("degraded: with findings and repositioned", () => {
    const text = buildOverviewText({
      allFindingsCount: 3,
      postableFindingsCount: 2,
      repostedFindingsCount: 1,
      reviewRunId: "run-abc",
      triageDegradation: {
        model: "minimax/m2.7",
        parseFailures: 1,
        totalBatches: 1,
      },
    });

    expect(text).toBe(
      "⚠ AI review degraded: triage parser failed on 1/1 batches (model=minimax/m2.7). 3 finding(s), 2 posted inline, 1 repositioned after force-push. See logs reviewRunId=run-abc."
    );
  });

  it("not degraded when failures are partial", () => {
    const text = buildOverviewText({
      allFindingsCount: 0,
      postableFindingsCount: 0,
      repostedFindingsCount: 0,
      reviewRunId: "run-abc",
      triageDegradation: {
        model: "minimax/m2.7",
        parseFailures: 1,
        totalBatches: 3,
      },
    });

    expect(text).toBe("AI review complete — no issues found.");
  });

  it("not degraded when triageDegradation is absent", () => {
    const text = buildOverviewText({
      allFindingsCount: 0,
      postableFindingsCount: 0,
      repostedFindingsCount: 0,
      reviewRunId: "run-abc",
      triageDegradation: undefined,
    });

    expect(text).toBe("AI review complete — no issues found.");
  });

  it("complete: no findings", () => {
    const text = buildOverviewText({
      allFindingsCount: 0,
      postableFindingsCount: 0,
      repostedFindingsCount: 0,
      reviewRunId: "run-abc",
      triageDegradation: undefined,
    });

    expect(text).toBe("AI review complete — no issues found.");
  });

  it("complete: with findings", () => {
    const text = buildOverviewText({
      allFindingsCount: 5,
      postableFindingsCount: 4,
      repostedFindingsCount: 0,
      reviewRunId: "run-abc",
      triageDegradation: undefined,
    });

    expect(text).toBe("AI review complete: 5 finding(s), 4 posted inline.");
  });

  it("complete: with findings and repositioned", () => {
    const text = buildOverviewText({
      allFindingsCount: 5,
      postableFindingsCount: 4,
      repostedFindingsCount: 2,
      reviewRunId: "run-abc",
      triageDegradation: undefined,
    });

    expect(text).toBe(
      "AI review complete: 5 finding(s), 4 posted inline, 2 repositioned after force-push."
    );
  });

  it("not degraded when totalBatches is 0", () => {
    const text = buildOverviewText({
      allFindingsCount: 0,
      postableFindingsCount: 0,
      repostedFindingsCount: 0,
      reviewRunId: "run-abc",
      triageDegradation: {
        model: "minimax/m2.7",
        parseFailures: 0,
        totalBatches: 0,
      },
    });

    expect(text).toBe("AI review complete — no issues found.");
  });
});
