import { describe, expect, it } from "vitest";

import { RULE_CATALOG_VERSION } from "~/domain/rule-catalog/rule-catalog";
import { MemoryCache } from "~/infrastructure/cache/memory-cache";
import { createMockCodeHost } from "~/test-utils/mock-code-host";
import { createMockInfraRepoPorts } from "~/test-utils/mock-infra-repo-ports";
import { createMockLogger } from "~/test-utils/mock-logger";
import { createMockReviewConfig } from "~/test-utils/mock-review-config";

import {
  buildOverviewText,
  ReviewRunCompletionService,
} from "./review-run-completion.service";

describe("buildOverviewText", () => {
  it("degraded: no findings", () => {
    const text = buildOverviewText({
      acceptedFindingsCount: 0,
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
      "⚠ AI review degraded: triage parser failed on 1/1 batches (model=minimax/m2.7); file-review found no issues. See logs reviewRunId=run-abc.",
    );
  });

  it("degraded: with findings", () => {
    const text = buildOverviewText({
      acceptedFindingsCount: 3,
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
      "⚠ AI review degraded: triage parser failed on 1/1 batches (model=minimax/m2.7). 3 finding(s), 2 posted inline. See logs reviewRunId=run-abc.",
    );
  });

  it("degraded: with findings and repositioned", () => {
    const text = buildOverviewText({
      acceptedFindingsCount: 3,
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
      "⚠ AI review degraded: triage parser failed on 1/1 batches (model=minimax/m2.7). 3 finding(s), 2 posted inline, 1 repositioned after force-push. See logs reviewRunId=run-abc.",
    );
  });

  it("not degraded when failures are partial", () => {
    const text = buildOverviewText({
      acceptedFindingsCount: 0,
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
      acceptedFindingsCount: 0,
      postableFindingsCount: 0,
      repostedFindingsCount: 0,
      reviewRunId: "run-abc",
      triageDegradation: undefined,
    });

    expect(text).toBe("AI review complete — no issues found.");
  });

  it("complete: no findings", () => {
    const text = buildOverviewText({
      acceptedFindingsCount: 0,
      postableFindingsCount: 0,
      repostedFindingsCount: 0,
      reviewRunId: "run-abc",
      triageDegradation: undefined,
    });

    expect(text).toBe("AI review complete — no issues found.");
  });

  it("complete: with findings", () => {
    const text = buildOverviewText({
      acceptedFindingsCount: 5,
      postableFindingsCount: 4,
      repostedFindingsCount: 0,
      reviewRunId: "run-abc",
      triageDegradation: undefined,
    });

    expect(text).toBe("AI review complete: 5 finding(s), 4 posted inline.");
  });

  it("complete: with findings and repositioned", () => {
    const text = buildOverviewText({
      acceptedFindingsCount: 5,
      postableFindingsCount: 4,
      repostedFindingsCount: 2,
      reviewRunId: "run-abc",
      triageDegradation: undefined,
    });

    expect(text).toBe(
      "AI review complete: 5 finding(s), 4 posted inline, 2 repositioned after force-push.",
    );
  });

  it("not degraded when totalBatches is 0", () => {
    const text = buildOverviewText({
      acceptedFindingsCount: 0,
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

describe("ReviewRunCompletionService.completeSuccessfulRun", () => {
  it("links the rule catalog in the summary note", async () => {
    const codeHost = createMockCodeHost();
    const service = new ReviewRunCompletionService(
      createMockInfraRepoPorts(),
      codeHost,
      new MemoryCache<boolean>(),
      createMockLogger(),
      "https://verqen.dev/rules",
    );

    await service.completeSuccessfulRun({
      acceptedFindings: [],
      baseSha: "base-sha",
      diffsFileCount: 1,
      headSha: "head-sha",
      mrIid: 42,
      postableFindings: [],
      projectId: 1,
      repostedFindings: [],
      reviewConfig: createMockReviewConfig(),
      reviewRunId: "run-1",
      suppressedCount: 0,
      tokenUsageByModel: {},
      totalCompletionTokens: 0,
      totalPromptTokens: 0,
    });

    expect(codeHost.calls.postNote[0]?.[2]).toContain(
      `Rule catalog ${RULE_CATALOG_VERSION}: https://verqen.dev/rules`,
    );
  });
});
