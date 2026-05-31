import { describe, expect, it } from "vitest";

import type { DiffFile } from "~/domain/types/code-host.types";
import { parseDiff } from "~/review/diff-parser";

import { resolveDiffHunkForAnchor } from "./resolve-diff-hunk-for-anchor";

function makeDiffFile(
  diffBody: string,
  newPath = "src/foo.ts",
  oldPath = "src/foo.ts",
): DiffFile {
  return { diff: diffBody, newPath, oldPath };
}

describe("resolveDiffHunkForAnchor", () => {
  it("returns expanded old/new spans for anchor inside a mixed hunk", () => {
    const diffBody = "@@ -10,3 +10,3 @@\n ctx\n+added\n-removed";
    const parsed = parseDiff(makeDiffFile(diffBody));
    const actual = resolveDiffHunkForAnchor(parsed, 11, "added", {
      contextLines: 1,
    });
    expect(actual).toMatchObject({
      kind: "ok",
      lineRanges: {
        headNewEndInclusive: 12,
        headNewStartInclusive: 9,
        oldEndInclusive: 12,
        oldStartInclusive: 9,
      },
    });
  });

  it("returns error when anchor row is missing", () => {
    const parsed = parseDiff(makeDiffFile("@@ -1,2 +1,2 @@\n context\n+add1"));
    const actual = resolveDiffHunkForAnchor(parsed, 99, "added");
    expect(actual.kind).toBe("error");
  });
});
