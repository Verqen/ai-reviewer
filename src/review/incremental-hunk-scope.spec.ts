import { describe, expect, it } from "vitest";

import type { DiffFile } from "~/domain/types/code-host.types";
import { parseDiff } from "~/review/diff-parser";

import { scopeDeltaDiffsToMrHunks } from "./incremental-hunk-scope";

const DELTA_WITH_TWO_HUNKS =
  "@@ -10,2 +10,2 @@\n-old main line\n+new main line\n shared\n@@ -100,2 +100,2 @@\n-old feature line\n+new feature line\n shared\n";

describe("scopeDeltaDiffsToMrHunks", () => {
  it("keeps only overlapping hunks when file has mixed main and feature changes", () => {
    const delta: DiffFile = {
      diff: DELTA_WITH_TWO_HUNKS,
      newPath: "src/mixed.ts",
      oldPath: "src/mixed.ts",
    };
    const mr: DiffFile = {
      diff: "@@ -100,2 +100,2 @@\n-old feature line\n+new feature line adjusted\n shared\n",
      newPath: "src/mixed.ts",
      oldPath: "src/mixed.ts",
    };
    const scoped = scopeDeltaDiffsToMrHunks([delta], [mr]);
    expect(scoped).toHaveLength(1);
    const parsed = parseDiff(scoped[0]!);
    const allReferencedLines = parsed.lines.flatMap((line) =>
      [line.newLine, line.oldLine].filter(
        (value): value is number => value !== undefined,
      ),
    );
    expect(allReferencedLines.every((line) => line >= 100)).toBe(true);
  });

  it("keeps renamed deltas when oldPath matches MR path", () => {
    const delta: DiffFile = {
      diff: "@@ -5,1 +5,1 @@\n-old rename line\n+new rename line\n",
      newPath: "src/new-name.ts",
      oldPath: "src/legacy-name.ts",
    };
    const mr: DiffFile = {
      diff: "@@ -5,1 +5,1 @@\n-old rename line\n+new rename line in mr\n",
      newPath: "src/another-new-name.ts",
      oldPath: "src/legacy-name.ts",
    };
    const scoped = scopeDeltaDiffsToMrHunks([delta], [mr]);
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.newPath).toBe("src/new-name.ts");
    expect(scoped[0]?.oldPath).toBe("src/legacy-name.ts");
  });

  it("returns empty list when no hunk overlaps current MR", () => {
    const delta: DiffFile = {
      diff: "@@ -10,1 +10,1 @@\n-old main line\n+new main line\n",
      newPath: "src/mixed.ts",
      oldPath: "src/mixed.ts",
    };
    const mr: DiffFile = {
      diff: "@@ -100,1 +100,1 @@\n-old feature line\n+new feature line\n",
      newPath: "src/mixed.ts",
      oldPath: "src/mixed.ts",
    };
    const scoped = scopeDeltaDiffsToMrHunks([delta], [mr]);
    expect(scoped).toEqual([]);
  });
});
