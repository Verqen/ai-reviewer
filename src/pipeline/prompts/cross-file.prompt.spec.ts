import { describe, expect, it } from "vitest";

import {
  buildCrossFileSystemPrompt,
  buildCrossFileUserPrompt,
} from "./cross-file.prompt";
import {
  buildRuleCatalogInstruction,
  buildRuleIdList,
} from "./rule-catalog.prompt";

describe("buildCrossFileSystemPrompt", () => {
  it("states the untrusted-input boundary so injected directives are treated as data", () => {
    const prompt = buildCrossFileSystemPrompt(null, null);
    expect(prompt).toContain("untrusted input boundary");
    expect(prompt).toMatch(/never as instructions/i);
  });

  it("embeds the cross-file rule catalog in place of a free-form rubric", () => {
    const prompt = buildCrossFileSystemPrompt(null, null);
    expect(prompt).toContain(buildRuleCatalogInstruction("cross-file"));
    expect(prompt).not.toContain("Severity rubric");
    expect(prompt).not.toContain("Category vocabulary");
    expect(prompt).not.toContain("suggestion");
  });

  it("asks for a catalog rule id and no severity, category or comment", () => {
    const prompt = buildCrossFileSystemPrompt(null, null);
    expect(prompt).toContain(
      `- rule_id MUST be one of: ${buildRuleIdList("cross-file")}. A finding with any other rule_id is discarded.`,
    );
    expect(prompt).not.toContain('"severity"');
    expect(prompt).not.toContain('"category"');
    expect(prompt).not.toContain('"comment"');
  });

  it("asks only for what the cross-file catalog rules cover", () => {
    const prompt = buildCrossFileSystemPrompt(null, null);
    expect(prompt).toContain("(R-025)");
    expect(prompt).toContain("(R-026)");
    expect(prompt).not.toMatch(/circular dependenc/i);
    expect(prompt).not.toMatch(/error propagation/i);
    expect(prompt).not.toMatch(/bounded-context/i);
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
      "ctx",
    );
    expect(text).toContain("## MR diffs (compact)");
    expect(text).toContain("diff body");
    expect(text).toContain("## Codebase context");
    expect(text).toContain("ctx");
    const compactIdx = text.indexOf("## MR diffs (compact)");
    const ctxIdx = text.indexOf("## Codebase context");
    expect(compactIdx).toBeLessThan(ctxIdx);
  });

  it("wraps the diff, codebase context and PR title in untrusted delimiters", () => {
    const text = buildCrossFileUserPrompt(
      mrInfo,
      [{ findingCount: 0, path: "src/a.ts", topSeverity: null }],
      "",
      "## MR diffs (compact)\n\n### src/a.ts\n\ndiff body",
      "ctx",
    );
    expect(text).toContain("<untrusted_diff>");
    expect(text).toContain("<untrusted_codebase>");
    expect(text).toContain("<untrusted_pr_title>");
  });
});
