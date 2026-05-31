import { describe, expect, it } from "vitest";

import type { DiffFile } from "~/domain/types/code-host.types";
import type { Finding } from "~/domain/types/review.types";
import { parseDiff } from "~/review/diff-parser";

import {
  buildPosition,
  originalSnippetMatchesDiff,
} from "./finding-inline-position";

const SAMPLE_DIFF: DiffFile = {
  diff: "@@ -1,2 +1,3 @@\n context\n+added line\n-removed line\n",
  newPath: "src/index.ts",
  oldPath: "src/index.ts",
};

const VERSIONS = { baseSha: "b", headSha: "h", startSha: "s" };

describe("buildPosition", () => {
  it("returns null when file is not in diff", () => {
    const diffs = [parseDiff(SAMPLE_DIFF)];
    const finding: Finding = {
      category: "style",
      comment: "c",
      confidence: 1,
      filePath: "other.ts",
      lineNumber: 1,
      lineType: "added",
      model: "m",
      passName: "p",
      severity: "info",
    };
    expect(buildPosition(finding, VERSIONS, diffs)).toBeNull();
  });

  it("builds position for added line on new line", () => {
    const diffs = [parseDiff(SAMPLE_DIFF)];
    const finding: Finding = {
      category: "style",
      comment: "c",
      confidence: 1,
      filePath: "src/index.ts",
      lineNumber: 2,
      lineType: "added",
      model: "m",
      passName: "p",
      severity: "info",
    };
    const result = buildPosition(finding, VERSIONS, diffs);
    expect(result).not.toBeNull();
    expect(result?.position.newLine).toBe(2);
    expect(result?.position.newPath).toBe("src/index.ts");
  });
});

describe("buildPosition: strict in-hunk matching", () => {
  const SNAP_DIFF: DiffFile = {
    diff: "@@ -10,5 +10,7 @@\n line10\n line11\n+added12\n+added13\n line14\n+added15\n line16\n",
    newPath: "src/snap.ts",
    oldPath: "src/snap.ts",
  };

  it("returns null when line is outside the hunk", () => {
    const diffs = [parseDiff(SNAP_DIFF)];
    const finding: Finding = {
      category: "style",
      comment: "c",
      confidence: 1,
      filePath: "src/snap.ts",
      lineNumber: 999,
      lineType: "added",
      model: "m",
      passName: "p",
      severity: "info",
    };
    expect(buildPosition(finding, VERSIONS, diffs)).toBeNull();
  });

  it("does NOT snap when line is already in the hunk", () => {
    const diffs = [parseDiff(SNAP_DIFF)];
    const finding: Finding = {
      category: "style",
      comment: "c",
      confidence: 1,
      filePath: "src/snap.ts",
      lineNumber: 13,
      lineType: "added",
      model: "m",
      passName: "p",
      severity: "info",
    };
    const result = buildPosition(finding, VERSIONS, diffs);
    expect(result).not.toBeNull();
    expect(result?.position.newLine).toBe(13);
  });

  it("returns null when file has no added lines (deletion-only)", () => {
    const deletionOnly: DiffFile = {
      diff: "@@ -1,3 +1,1 @@\n keep1\n-delete2\n-delete3\n",
      newPath: "src/del.ts",
      oldPath: "src/del.ts",
    };
    const diffs = [parseDiff(deletionOnly)];
    const finding: Finding = {
      category: "style",
      comment: "c",
      confidence: 1,
      filePath: "src/del.ts",
      lineNumber: 999,
      lineType: "added",
      model: "m",
      passName: "p",
      severity: "info",
    };
    expect(buildPosition(finding, VERSIONS, diffs)).toBeNull();
  });
});

describe("originalSnippetMatchesDiff", () => {
  it("returns true when snippet matches diff text for line range", () => {
    const diffs = [parseDiff(SAMPLE_DIFF)];
    const finding: Finding = {
      category: "style",
      comment: "c",
      confidence: 1,
      filePath: "src/index.ts",
      lineNumber: 2,
      lineType: "added",
      model: "m",
      passName: "p",
      severity: "info",
    };
    expect(originalSnippetMatchesDiff("added line", finding, diffs)).toBe(true);
  });

  it("returns false when file missing from diffs", () => {
    const diffs = [parseDiff(SAMPLE_DIFF)];
    const finding: Finding = {
      category: "style",
      comment: "c",
      confidence: 1,
      filePath: "missing.ts",
      lineNumber: 1,
      lineType: "added",
      model: "m",
      passName: "p",
      severity: "info",
    };
    expect(originalSnippetMatchesDiff("x", finding, diffs)).toBe(false);
  });
});
