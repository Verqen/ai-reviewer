import { describe, expect, it } from "vitest";

import { formatParsedDiffForPromptWithBudget } from "~/review/diff-parser";
import { buildWholeFileDiffs } from "~/review/whole-file-diff";

function file(
  path: string,
  lines: readonly string[],
): {
  content: Buffer;
  path: string;
} {
  return { content: Buffer.from(`${lines.join("\n")}\n`), path };
}

function numberedLines(count: number, width = 12): string[] {
  return Array.from({ length: count }, (_, index) =>
    `line ${String(index + 1)}`.padEnd(width, "x"),
  );
}

describe("buildWholeFileDiffs", () => {
  it("presents a whole file as one added hunk starting at line 1", () => {
    const { diffs } = buildWholeFileDiffs([
      file("src/a.ts", ["const a = 1;", "", "export { a };"]),
    ]);

    expect(diffs).toEqual([
      {
        lines: [
          {
            content: "const a = 1;",
            hunkHeader: "@@ -0,0 +1,3 @@",
            newLine: 1,
            type: "added",
          },
          {
            content: "",
            hunkHeader: "@@ -0,0 +1,3 @@",
            newLine: 2,
            type: "added",
          },
          {
            content: "export { a };",
            hunkHeader: "@@ -0,0 +1,3 @@",
            newLine: 3,
            type: "added",
          },
        ],
        newPath: "src/a.ts",
        oldPath: "src/a.ts",
      },
    ]);
  });

  it("strips carriage returns from CRLF files", () => {
    const { diffs } = buildWholeFileDiffs([
      { content: Buffer.from("a\r\nb\r\n"), path: "src/crlf.ts" },
    ]);

    expect(diffs[0]?.lines.map((line) => line.content)).toEqual(["a", "b"]);
  });

  it("splits a 1500-line file into 600-line hunks the prompt never truncates", () => {
    const { diffs } = buildWholeFileDiffs([
      file("src/big.ts", numberedLines(1500)),
    ]);

    expect(diffs.map((diff) => diff.lines[0]?.hunkHeader)).toEqual([
      "@@ -0,0 +1,600 @@",
      "@@ -0,0 +601,600 @@",
      "@@ -0,0 +1201,300 @@",
    ]);
    expect(diffs.map((diff) => diff.lines[0]?.newLine)).toEqual([1, 601, 1201]);
    expect(
      diffs.flatMap((diff) => diff.lines).map((line) => line.newLine),
    ).toEqual(Array.from({ length: 1500 }, (_, index) => index + 1));
    for (const diff of diffs) {
      expect(formatParsedDiffForPromptWithBudget(diff).isTruncated).toBe(false);
    }
  });

  it("splits by character budget when lines are long", () => {
    const { diffs } = buildWholeFileDiffs([
      file("src/wide.ts", numberedLines(600, 120)),
    ]);

    expect(diffs.length).toBeGreaterThan(1);
    for (const diff of diffs) {
      expect(formatParsedDiffForPromptWithBudget(diff).isTruncated).toBe(false);
    }
  });

  it("drops skip-filtered, binary, oversized and empty files", () => {
    const { diffs, reviewablePaths } = buildWholeFileDiffs([
      file("pnpm-lock.yaml", ["lockfileVersion: 9"]),
      file("dist/index.js", ["console.log(1);"]),
      { content: Buffer.from([0x50, 0x4b, 0x00, 0x03]), path: "src/data.bin" },
      { content: Buffer.alloc(600_000, "a"), path: "src/huge.ts" },
      { content: Buffer.alloc(0), path: "src/empty.ts" },
      file("src/kept.ts", ["export {};"]),
    ]);

    expect(reviewablePaths).toEqual(["src/kept.ts"]);
    expect(diffs.map((diff) => diff.newPath)).toEqual(["src/kept.ts"]);
  });

  it("names the reason each dropped file was not counted", () => {
    const { skippedFiles } = buildWholeFileDiffs([
      file("pnpm-lock.yaml", ["lockfileVersion: 9"]),
      file("dist/index.js", ["console.log(1);"]),
      { content: Buffer.from([0x50, 0x4b, 0x00, 0x03]), path: "src/data.bin" },
      { content: Buffer.alloc(600_000, "a"), path: "src/huge.ts" },
      { content: Buffer.alloc(0), path: "src/empty.ts" },
      file("src/kept.ts", ["export {};"]),
    ]);

    expect(skippedFiles).toEqual([
      { path: "pnpm-lock.yaml", reason: "lock" },
      { path: "dist/index.js", reason: "build" },
      { path: "src/data.bin", reason: "binary" },
      { path: "src/huge.ts", reason: "too_large" },
      { path: "src/empty.ts", reason: "empty" },
    ]);
  });
});
