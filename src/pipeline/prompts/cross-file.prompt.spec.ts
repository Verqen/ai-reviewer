import { describe, expect, it } from "vitest";

import {
  buildCrossFileSystemPrompt,
  buildCrossFileUserPrompt,
} from "./cross-file.prompt";

describe("buildCrossFileSystemPrompt", () => {
  it("includes DDD and Hexagonal cross-file checks", () => {
    const prompt = buildCrossFileSystemPrompt(null, null);
    expect(prompt).toContain("DDD bounded-context leaks");
    expect(prompt).toContain("Hexagonal dependency direction breaks");
    expect(prompt).toContain(
      "Domain modules should depend on abstractions, never on infrastructure adapters"
    );
  });

  it("includes strict TypeScript contract checks across modules", () => {
    const prompt = buildCrossFileSystemPrompt(null, null);
    expect(prompt).toContain("TypeScript contract checks across files");
    expect(prompt).toContain("breaking interface/type changes");
    expect(prompt).toContain("new unsafe casts at module boundaries");
  });

  it("requires findings to match allowable anchors tables in user MR diffs section", () => {
    const prompt = buildCrossFileSystemPrompt(null, null);
    expect(prompt).toContain("allowable anchors table");
    expect(prompt).toContain("MR diffs (compact)");
  });

  it("injects project and path rules when provided", () => {
    const prompt = buildCrossFileSystemPrompt("Global ** rule", "src only");
    expect(prompt).toContain("<project_rules>");
    expect(prompt).toContain("Global ** rule");
    expect(prompt).toContain("<path_rules>");
    expect(prompt).toContain("src only");
  });
});

describe("buildCrossFileUserPrompt", () => {
  const mrInfo = {
    description: "",
    iid: 1,
    projectId: 1,
    sourceBranch: "feature",
    targetBranch: "main",
    title: "MR",
  };

  it("includes MR diffs compact section before codebase context", () => {
    const text = buildCrossFileUserPrompt(
      mrInfo,
      [{ findingCount: 0, path: "src/a.ts", topSeverity: null }],
      "",
      "## MR diffs (compact)\n\n### src/a.ts\n\ndiff body",
      "ctx"
    );
    expect(text).toContain("## MR diffs (compact)");
    expect(text).toContain("diff body");
    expect(text).toContain("## Codebase context");
    expect(text).toContain("ctx");
    const compactIdx = text.indexOf("## MR diffs (compact)");
    const ctxIdx = text.indexOf("## Codebase context");
    expect(compactIdx).toBeLessThan(ctxIdx);
  });
});
