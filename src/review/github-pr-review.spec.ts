import { describe, expect, it } from "vitest";

import { buildPullRequestSummaryHeading } from "~/review/github-pr-review";

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
