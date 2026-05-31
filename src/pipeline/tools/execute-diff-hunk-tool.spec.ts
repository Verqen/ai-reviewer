import { describe, expect, it, vi } from "vitest";

import type { DiffFile } from "~/domain/types/code-host.types";
import type { ToolCall } from "~/domain/types/llm.types";
import { parseDiff } from "~/review/diff-parser";

import { executeDiffHunkTool } from "./execute-diff-hunk-tool";

function makeDiffFile(
  diffBody: string,
  newPath = "src/foo.ts",
  oldPath = "src/foo.ts",
): DiffFile {
  return { diff: diffBody, newPath, oldPath };
}

describe("executeDiffHunkTool", () => {
  it("prefixes anchor_used and baseline_slice/head_slice inclusive ranges before slices", async () => {
    const diffBody = "@@ -10,3 +10,3 @@\n ctx\n+added\n-removed";
    const parsed = parseDiff(makeDiffFile(diffBody));
    const readFileAtBaseline = vi.fn().mockResolvedValue("baseline-body");
    const readFile = vi.fn().mockResolvedValue("head-body");
    const call: ToolCall = {
      arguments: {
        context_lines: 1,
        line_number: 11,
        line_type: "added",
        path: "src/foo.ts",
      },
      id: "call-1",
      name: "diff_hunk",
    };
    const actual = await executeDiffHunkTool({
      call,
      maxToolChars: 50_000,
      overlay: { readFile, readFileAtBaseline },
      parsed,
    });
    expect(actual).toContain("anchor_used line_type=added line_number=11");
    expect(actual).toContain("baseline_slice lines=9-12 path=src/foo.ts");
    expect(actual).toContain("head_slice lines=9-12 path=src/foo.ts");
    expect(readFileAtBaseline).toHaveBeenCalledWith("src/foo.ts", 9, 12);
    expect(readFile).toHaveBeenCalledWith("src/foo.ts", 9, 12);
    expect(actual).toContain("baseline-body");
    expect(actual).toContain("head-body");
  });
});
