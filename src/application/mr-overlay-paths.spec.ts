import { describe, expect, it } from "vitest";

import type { DiffFile } from "~/domain/types/code-host.types";
import { parseDiff } from "~/review/diff-parser";

import { buildOverlayPathListsFromParsedDiffs } from "./mr-overlay-paths";

const DELETE_FILE_DIFF: DiffFile = {
  diff: "",
  newPath: "/dev/null",
  oldPath: "gone.ts",
};

const EDIT_FILE_DIFF: DiffFile = {
  diff: "@@ -1,2 +1,2 @@\n line1\n-old\n+new\n",
  newPath: "src/x.ts",
  oldPath: "src/x.ts",
};

describe("buildOverlayPathListsFromParsedDiffs", () => {
  it("separates deleted paths and non-null changed paths", () => {
    const parsed = [DELETE_FILE_DIFF, EDIT_FILE_DIFF].map(parseDiff);
    const actual = buildOverlayPathListsFromParsedDiffs(parsed);
    expect(actual.deletedPaths).toEqual(["gone.ts"]);
    expect(actual.changedPaths).toEqual(["src/x.ts"]);
  });
});
