import { describe, expect, it } from "vitest";

import type { DiffFile } from "~/domain/types/code-host.types";

import {
  formatAllowableAnchorsForPrompt,
  formatParsedDiffForPrompt,
  formatParsedDiffForPromptWithBudget,
  parseDiff,
} from "./diff-parser";

function makeDiffFile(
  diff: string,
  newPath = "src/foo.ts",
  oldPath = "src/foo.ts"
): DiffFile {
  return { diff, newPath, oldPath };
}

describe("parseDiff", () => {
  it("parses a single-hunk diff", () => {
    const diff =
      "@@ -1,3 +1,4 @@\n context\n+added line\n-removed line\n context2";
    const result = parseDiff(makeDiffFile(diff));

    expect(result.lines).toHaveLength(4);
    expect(result.lines[0]?.type).toBe("context");
    expect(result.lines[1]?.type).toBe("added");
    expect(result.lines[2]?.type).toBe("removed");
    expect(result.lines[3]?.type).toBe("context");
  });

  it("parses a multi-hunk diff with multiple @@ sections", () => {
    const diff =
      "@@ -1,2 +1,2 @@\n context\n+add1\n" +
      "@@ -10,2 +10,2 @@\n context2\n+add2";
    const result = parseDiff(makeDiffFile(diff));

    const hunkHeaders = [...new Set(result.lines.map((l) => l.hunkHeader))];
    expect(hunkHeaders).toHaveLength(2);
    expect(hunkHeaders[0]).toContain("@@ -1,2 +1,2 @@");
    expect(hunkHeaders[1]).toContain("@@ -10,2 +10,2 @@");
  });

  it("parses an added file (all + lines)", () => {
    const diff = "@@ -0,0 +1,3 @@\n+line1\n+line2\n+line3";
    const result = parseDiff(makeDiffFile(diff, "src/new.ts", "/dev/null"));

    expect(result.lines).toHaveLength(3);
    expect(result.lines.every((l) => l.type === "added")).toBe(true);
    expect(result.lines.every((l) => l.oldLine === undefined)).toBe(true);
  });

  it("parses a deleted file (all - lines)", () => {
    const diff = "@@ -1,3 +0,0 @@\n-line1\n-line2\n-line3";
    const result = parseDiff(makeDiffFile(diff, "/dev/null", "src/old.ts"));

    expect(result.lines).toHaveLength(3);
    expect(result.lines.every((l) => l.type === "removed")).toBe(true);
    expect(result.lines.every((l) => l.newLine === undefined)).toBe(true);
  });

  it("preserves oldPath and newPath for renamed file", () => {
    const diff = "@@ -1 +1 @@\n line";
    const result = parseDiff(
      makeDiffFile(diff, "src/new-name.ts", "src/old-name.ts")
    );

    expect(result.oldPath).toBe("src/old-name.ts");
    expect(result.newPath).toBe("src/new-name.ts");
  });

  it("returns empty lines array for empty diff (no hunks)", () => {
    const result = parseDiff(makeDiffFile(""));
    expect(result.lines).toHaveLength(0);
  });

  it("skips lines starting with backslash (no newline at end of file marker)", () => {
    const diff =
      "@@ -1,2 +1,2 @@\n+added\n\\ No newline at end of file\n-removed";
    const result = parseDiff(makeDiffFile(diff));

    const contents = result.lines.map((l) => l.content);
    expect(contents).not.toContain(" No newline at end of file");
    expect(result.lines.some((l) => l.type === "added")).toBe(true);
    expect(result.lines.some((l) => l.type === "removed")).toBe(true);
  });

  it("populates hunkHeader field on every DiffLine", () => {
    const header = "@@ -5,3 +5,3 @@";
    const diff = `${header}\n context\n+added\n-removed`;
    const result = parseDiff(makeDiffFile(diff));

    expect(result.lines.length).toBeGreaterThan(0);
    expect(result.lines.every((l) => l.hunkHeader === header)).toBe(true);
  });

  it("context lines have both oldLine and newLine", () => {
    const diff = "@@ -2,3 +2,3 @@\n ctx1\n+added\n ctx2";
    const result = parseDiff(makeDiffFile(diff));

    const contextLines = result.lines.filter((l) => l.type === "context");
    expect(contextLines.length).toBeGreaterThan(0);
    for (const line of contextLines) {
      expect(line.oldLine).toBeDefined();
      expect(line.newLine).toBeDefined();
    }
  });

  it("increments line numbers correctly across hunk", () => {
    const diff = "@@ -10,3 +10,3 @@\n ctx\n+added\n-removed";
    const result = parseDiff(makeDiffFile(diff));

    const contextLine = result.lines.find((l) => l.type === "context");
    const addedLine = result.lines.find((l) => l.type === "added");
    const removedLine = result.lines.find((l) => l.type === "removed");

    expect(contextLine?.oldLine).toBe(10);
    expect(contextLine?.newLine).toBe(10);
    expect(addedLine?.newLine).toBe(11);
    expect(removedLine?.oldLine).toBe(11);
  });

  it("ignores lines before any hunk header", () => {
    const diff =
      "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n line";
    const result = parseDiff(makeDiffFile(diff));

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]?.type).toBe("context");
  });
});

describe("formatParsedDiffForPrompt", () => {
  it("includes file path headers", () => {
    const diff = "@@ -1 +1 @@\n line";
    const parsed = parseDiff(makeDiffFile(diff, "src/bar.ts", "src/bar.ts"));
    const output = formatParsedDiffForPrompt(parsed);

    expect(output).toContain("--- src/bar.ts");
    expect(output).toContain("+++ src/bar.ts");
  });

  it("prefixes added lines with +", () => {
    const diff = "@@ -1 +1 @@\n+newline";
    const parsed = parseDiff(makeDiffFile(diff));
    const output = formatParsedDiffForPrompt(parsed);

    expect(output).toContain("+ newline");
  });

  it("prefixes removed lines with -", () => {
    const diff = "@@ -1 +0,0 @@\n-oldline";
    const parsed = parseDiff(makeDiffFile(diff));
    const output = formatParsedDiffForPrompt(parsed);

    expect(output).toContain("- oldline");
  });

  it("prefixes context lines with space", () => {
    const diff = "@@ -1 +1 @@\n context";
    const parsed = parseDiff(makeDiffFile(diff));
    const output = formatParsedDiffForPrompt(parsed);

    expect(output).toContain("   context");
  });

  it("uses old line number for removed lines", () => {
    const diff = "@@ -5,1 +5,0 @@\n-removed";
    const parsed = parseDiff(makeDiffFile(diff));
    const output = formatParsedDiffForPrompt(parsed);

    expect(output).toContain("L5");
  });

  it("returns only header when no lines", () => {
    const diff = "";
    const parsed = parseDiff(
      makeDiffFile(diff, "src/empty.ts", "src/empty.ts")
    );
    const output = formatParsedDiffForPrompt(parsed);

    expect(output).toBe("--- src/empty.ts\n+++ src/empty.ts\n");
  });
});

describe("formatParsedDiffForPromptWithBudget", () => {
  it("aligns allowableAnchorsText row count with diff body lines shown", () => {
    const diff =
      "@@ -1,3 +1,4 @@\n context\n+added line\n-removed line\n context2";
    const parsed = parseDiff(makeDiffFile(diff));
    const payload = formatParsedDiffForPromptWithBudget(parsed, {
      maxCharacters: 50_000,
      maxLines: 500,
    });
    const diffBodyLines = payload.text
      .split("\n")
      .slice(2)
      .filter((l) => !l.startsWith("..."));
    const anchorRows = payload.allowableAnchorsText
      .split("\n")
      .filter((line) => /^\| (added|removed|context) \| \d+ \|$/.test(line));
    expect(anchorRows).toHaveLength(diffBodyLines.length);
  });
});

describe("formatAllowableAnchorsForPrompt", () => {
  it("uses flat table when line count is at most threshold", () => {
    const lines = Array.from({ length: 3 }, (_, i) => ({
      content: `x${i}`,
      hunkHeader: "@@ -1 +1 @@",
      newLine: i + 1,
      type: "added" as const,
    }));
    const text = formatAllowableAnchorsForPrompt(lines);
    expect(text).toContain("| line_type | line_number |");
    expect(text).not.toContain("### H0");
  });

  it("groups by hunk labels when line count exceeds threshold", () => {
    const lines = Array.from({ length: 30 }, (_, i) => ({
      content: `x${i}`,
      hunkHeader: "@@ -1 +1 @@",
      newLine: i + 1,
      type: "added" as const,
    }));
    const text = formatAllowableAnchorsForPrompt(lines);
    expect(text).toContain("### H0");
  });
});
