import { describe, expect, it } from "vitest";

import {
  getPathRulesTextForFile,
  resolveProjectAndPathRulesText,
} from "./resolve-path-rules";

describe("getPathRulesTextForFile", () => {
  it("returns null when no rule matches", () => {
    const actual = getPathRulesTextForFile("src/x.ts", [
      { extraRules: "only root", path: "lib/**" },
    ]);
    expect(actual).toBeNull();
  });

  it("merges ** and more specific globs for a file", () => {
    const actual = getPathRulesTextForFile("src/x.ts", [
      { extraRules: "Global", path: "**" },
      { extraRules: "Under src", path: "src/**" },
    ]);
    expect(actual).toBe("Under src");
  });
});

describe("resolveProjectAndPathRulesText", () => {
  it("returns nulls for empty pathRules", () => {
    const actual = resolveProjectAndPathRulesText({
      filePaths: ["a.ts"],
      pathRules: [],
    });
    expect(actual.projectRules).toBeNull();
    expect(actual.pathRules).toBeNull();
  });

  it("exposes ** as projectRules and deduplicates path text across files", () => {
    const actual = resolveProjectAndPathRulesText({
      filePaths: ["src/a.ts", "src/b.ts"],
      pathRules: [{ extraRules: "Same for all", path: "**" }],
    });
    expect(actual.projectRules).toBe("Same for all");
    expect(actual.pathRules).toBeNull();
  });

  it("joins distinct per-file merged rules with blank line", () => {
    const actual = resolveProjectAndPathRulesText({
      filePaths: ["lib/x.ts", "src/y.ts"],
      pathRules: [
        { extraRules: "Global", path: "**" },
        { extraRules: "Lib only", path: "lib/**" },
        { extraRules: "Src only", path: "src/**" },
      ],
    });
    expect(actual.projectRules).toBe("Global");
    expect(actual.pathRules).not.toContain("Global");
    expect(actual.pathRules).toContain("Lib only");
    expect(actual.pathRules).toContain("Src only");
  });
});
