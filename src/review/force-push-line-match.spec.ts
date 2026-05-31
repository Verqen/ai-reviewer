import { describe, expect, it } from "vitest";

import { PipelineConfig } from "~/config/pipeline.config";
import type { DiffFile } from "~/domain/types/code-host.types";
import type { ReviewFinding } from "~/domain/types/review.types";
import { parseDiff } from "~/review/diff-parser";
import { planForcePushLineCorrelation } from "~/review/force-push-line-match";

function makePipelineConfig(): PipelineConfig {
  return new PipelineConfig();
}

function matchOptions(): {
  lineMatchTabWidth: number;
  lineWindow: number;
} {
  const cfg = makePipelineConfig();
  return {
    lineMatchTabWidth: cfg.envs.FORCE_PUSH_LINE_MATCH_TAB_WIDTH,
    lineWindow: cfg.envs.FORCE_PUSH_LINE_WINDOW,
  };
}

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    category: "bug",
    comment: "test finding",
    confidence: 0.9,
    filePath: "src/foo.ts",
    hostDiscussionId: "disc-abc",
    id: "finding-1",
    lineExcerpt: "existing",
    lineNumber: 3,
    lineType: "added",
    model: "test",
    passName: "file-review",
    resolution: "pending",
    reviewRunId: "run-old",
    severity: "warning",
    ...overrides,
  };
}

function parseMrFile(file: DiffFile) {
  return parseDiff(file);
}

describe("planForcePushLineCorrelation", () => {
  describe("content matching (normalizeLineContent)", () => {
    it("finds line with trailing whitespace in excerpt", () => {
      const mrFile: DiffFile = {
        diff: "@@ -1,3 +1,3 @@\n context\n+existing   \n last\n",
        newPath: "src/foo.ts",
        oldPath: "src/foo.ts",
      };
      const finding = makeFinding({
        filePath: "src/foo.ts",
        hostDiscussionId: "disc-ws",
        lineExcerpt: "existing",
        lineNumber: 2,
      });
      const plan = planForcePushLineCorrelation(
        [finding],
        [parseMrFile(mrFile)],
        matchOptions(),
      );
      expect(plan.correlated.map((c) => c.finding.hostDiscussionId)).toContain(
        "disc-ws",
      );
    });

    it("finds line when excerpt differs only by internal whitespace", () => {
      const mrFile: DiffFile = {
        diff: "@@ -1,3 +1,3 @@\n context\n+value      with  spaces\n last\n",
        newPath: "src/foo.ts",
        oldPath: "src/foo.ts",
      };
      const finding = makeFinding({
        filePath: "src/foo.ts",
        hostDiscussionId: "disc-internal-ws",
        lineExcerpt: "value with spaces",
        lineNumber: 2,
      });
      const plan = planForcePushLineCorrelation(
        [finding],
        [parseMrFile(mrFile)],
        matchOptions(),
      );
      expect(plan.correlated.map((c) => c.finding.hostDiscussionId)).toContain(
        "disc-internal-ws",
      );
    });

    it("finds line when diff uses leading tab and excerpt uses equivalent spaces", () => {
      const mrFile: DiffFile = {
        diff: `@@ -1,3 +1,3 @@\n context\n+\tfoo\n last\n`,
        newPath: "src/foo.ts",
        oldPath: "src/foo.ts",
      };
      const finding = makeFinding({
        filePath: "src/foo.ts",
        hostDiscussionId: "disc-tab-vs-spaces",
        lineExcerpt: "    foo",
        lineNumber: 2,
      });
      const plan = planForcePushLineCorrelation(
        [finding],
        [parseMrFile(mrFile)],
        matchOptions(),
      );
      expect(plan.correlated.map((c) => c.finding.hostDiscussionId)).toContain(
        "disc-tab-vs-spaces",
      );
    });

    it("finds line when diff uses two leading tabs and excerpt uses eight spaces", () => {
      const mrFile: DiffFile = {
        diff: `@@ -1,3 +1,3 @@\n context\n+\t\tbar\n last\n`,
        newPath: "src/foo.ts",
        oldPath: "src/foo.ts",
      };
      const finding = makeFinding({
        filePath: "src/foo.ts",
        hostDiscussionId: "disc-two-tabs",
        lineExcerpt: "        bar",
        lineNumber: 2,
      });
      const plan = planForcePushLineCorrelation(
        [finding],
        [parseMrFile(mrFile)],
        matchOptions(),
      );
      expect(plan.correlated.map((c) => c.finding.hostDiscussionId)).toContain(
        "disc-two-tabs",
      );
    });

    it("falls back to full diff scan when line is outside configured window", () => {
      const mrFile: DiffFile = {
        diff: "@@ -1,3 +1,3 @@\n context\n+fallback match content\n last\n",
        newPath: "src/foo.ts",
        oldPath: "src/foo.ts",
      };
      const finding = makeFinding({
        filePath: "src/foo.ts",
        hostDiscussionId: "disc-full-scan",
        hunkHeader: undefined,
        lineExcerpt: "fallback match content",
        lineNumber: 10_000,
      });
      const plan = planForcePushLineCorrelation(
        [finding],
        [parseMrFile(mrFile)],
        matchOptions(),
      );
      const hasExpectedCorrelation = plan.correlated.some(
        (candidate) =>
          candidate.finding.hostDiscussionId === "disc-full-scan" &&
          candidate.newLineNumber === 2,
      );
      expect(hasExpectedCorrelation).toBe(true);
    });
  });
});
