import { describe, expect, it } from "vitest";

import { buildAnalysisDisciplineInstruction } from "~/pipeline/prompts/file-review-analysis-discipline";

import {
  buildFileReviewAnalysisSystemBlocks,
  buildFileReviewAnalysisUserPrompt,
  buildFileReviewExtractionSystemBlocks,
  buildFileReviewExtractionUserPrompt,
} from "./file-review.prompt";
import { formatCommentWithSuggestion } from "./suggestion-formatter";

function analysisSystemText(projectRules: string | null = null): string {
  return buildFileReviewAnalysisSystemBlocks(projectRules, undefined, true)
    .map((b) => b.text)
    .join("\n");
}

function extractionSystemText(): string {
  return buildFileReviewExtractionSystemBlocks(true)
    .map((b) => b.text)
    .join("\n");
}

describe("buildFileReviewAnalysisSystemBlocks", () => {
  it("asks for phase 1 analysis only without JSON output", () => {
    const text = analysisSystemText();
    expect(text).toContain("Phase 1 (analysis only)");
    expect(text).toContain("Do not output JSON");
  });

  it("instructs to cite diff lines with L markers", () => {
    expect(analysisSystemText()).toContain("L<number> markers");
  });

  it("requires tool verification before missing-file claims", () => {
    const text = analysisSystemText();
    expect(text).toContain(
      "Never claim that an imported file does not exist unless you first verify it with repository tools",
    );
  });

  it("forces output language (default English)", () => {
    expect(analysisSystemText()).toContain(
      "You MUST write the entire analysis in English.",
    );
  });

  it("respects an explicit language override", () => {
    const blocks = buildFileReviewAnalysisSystemBlocks(
      null,
      undefined,
      true,
      "Russian",
    );
    const text = blocks.map((b) => b.text).join("\n");
    expect(text).toContain("You MUST write the entire analysis in Russian.");
  });

  it("includes DDD boundaries and runtime-impacting focus", () => {
    const text = analysisSystemText();
    expect(text).toContain("architecture boundaries (DDD/hexagonal)");
    expect(text).toContain("runtime-impacting issues");
  });

  it("includes analysis discipline for checkable line-anchored output", () => {
    expect(analysisSystemText()).toContain(
      buildAnalysisDisciplineInstruction("English"),
    );
  });

  it("returns single text block with ephemeral 1h cache_control when applyCacheControl=true", () => {
    const blocks = buildFileReviewAnalysisSystemBlocks(null, undefined, true);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("text");
    expect(blocks[0]?.cacheControl).toEqual({ ttl: "1h", type: "ephemeral" });
  });

  it("omits cache_control when applyCacheControl=false", () => {
    const blocks = buildFileReviewAnalysisSystemBlocks(null, undefined, false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.cacheControl).toBeUndefined();
  });

  it("includes architecture snapshot when provided", () => {
    const blocks = buildFileReviewAnalysisSystemBlocks(
      null,
      "<package_json>{}</package_json>",
      true,
    );
    expect(blocks[0]?.text).toContain("<architecture_snapshot>");
    expect(blocks[0]?.text).toContain("<package_json>{}</package_json>");
  });

  it("injects project rules into cached block", () => {
    const blocks = buildFileReviewAnalysisSystemBlocks(
      "PROJECT_RULE",
      undefined,
      true,
    );
    expect(blocks[0]?.text).toContain("Project rules:");
    expect(blocks[0]?.text).toContain("PROJECT_RULE");
  });
});

describe("buildFileReviewExtractionSystemBlocks", () => {
  it("does not embed phase-1 analysis discipline instruction", () => {
    expect(extractionSystemText()).not.toContain(
      "Discipline (phase 1 analysis)",
    );
  });

  it("includes suggestion field instructions via schema", () => {
    const text = extractionSystemText();
    expect(text).toContain("suggestion");
    expect(text).toContain("original_snippet");
  });

  it("instructs to include suggestion only when confidence >= 0.8", () => {
    expect(extractionSystemText()).toContain("confidence >= 0.8");
  });

  it("keeps rationale in comment and patch-only content in suggestion", () => {
    const text = extractionSystemText();
    expect(text).toContain("Keep rationale strictly in comment");
    expect(text).toContain(
      "suggestion must contain only replacement code lines",
    );
  });

  it("allows empty suggestion value for deletion-only fixes", () => {
    expect(extractionSystemText()).toContain(
      "suggestion may be an empty string to produce deletion-only apply suggestion",
    );
  });

  it("instructs grounded extraction only", () => {
    const text = extractionSystemText();
    expect(text).toContain("ONLY issues clearly grounded");
    expect(text).toContain("Do not invent");
  });

  it("instructs to anchor line_number and line_type to the user anchors table", () => {
    const text = extractionSystemText();
    expect(text).toContain("allowable anchors table");
    expect(text).toContain("line_type");
    expect(text).toContain("end_line");
    expect(text).not.toContain("start_line");
  });

  it("includes verified_repo_path marker rule", () => {
    expect(extractionSystemText()).toContain("[verified_repo_path:");
  });
});

describe("buildFileReviewAnalysisUserPrompt", () => {
  const mrInfo = {
    description: "desc",
    iid: 1,
    projectId: 1,
    sourceBranch: "feat",
    targetBranch: "main",
    title: "MR",
  };

  it("puts path rules into user prompt when provided", () => {
    const text = buildFileReviewAnalysisUserPrompt(mrInfo, "diff", "PATH_RULE");
    expect(text).toContain("Path rules:");
    expect(text).toContain("PATH_RULE");
  });

  it("omits path rules section when null", () => {
    const text = buildFileReviewAnalysisUserPrompt(mrInfo, "diff", null);
    expect(text).not.toContain("Path rules:");
  });

  it("does not include allowable anchors section", () => {
    const text = buildFileReviewAnalysisUserPrompt(
      mrInfo,
      "--- a\n+++ b\n",
      null,
    );
    expect(text).not.toContain("Allowable anchors");
  });
});

describe("buildFileReviewExtractionUserPrompt", () => {
  it("includes target file path, analysis, and closed anchor list", () => {
    const text = buildFileReviewExtractionUserPrompt({
      allowableAnchorsText: "| added | 1 |",
      analysisText: "## Risk\nsomething",
      filePath: "src/x.ts",
    });
    expect(text).toContain("Target file_path for every finding: src/x.ts");
    expect(text).toContain("Prior analysis:");
    expect(text).toContain("## Risk");
    expect(text).toContain("Allowable anchors (closed list");
    expect(text).toContain("| added | 1 |");
  });
});

describe("formatCommentWithSuggestion", () => {
  it("formats comment with severity header", () => {
    const result = formatCommentWithSuggestion(
      "Potential null reference",
      "warning",
    );
    expect(result).toBe("[WARNING] Potential null reference");
  });

  it("appends single-line suggestion block when all conditions met", () => {
    const result = formatCommentWithSuggestion(
      "Missing null check",
      "warning",
      "if (user != null) {\n  user.update(data);\n}",
      "user.update(data);",
      "added",
      42,
      undefined,
    );
    expect(result).toContain("```suggestion:-0+0");
    expect(result).toContain("if (user != null)");
  });

  it("formats multi-line suggestion block with correct offset", () => {
    const result = formatCommentWithSuggestion(
      "Missing null check",
      "critical",
      "if (user != null) {\n  user.update(data);\n  user.save();\n}",
      "user.update(data);\nuser.save();",
      "added",
      42,
      43,
    );
    expect(result).toContain("```suggestion:-0+1");
  });

  it("falls back to plain comment when lineType is removed", () => {
    const result = formatCommentWithSuggestion(
      "This line was removed",
      "info",
      "replacement code",
      "original code",
      "removed",
      10,
      undefined,
    );
    expect(result).not.toContain("```suggestion");
    expect(result).toBe("[INFO] This line was removed");
  });

  it("falls back to plain comment when suggestion is undefined", () => {
    const result = formatCommentWithSuggestion(
      "Some finding",
      "nitpick",
      undefined,
      undefined,
      "added",
      5,
      undefined,
    );
    expect(result).not.toContain("```suggestion");
    expect(result).toBe("[NITPICK] Some finding");
  });

  it("falls back to plain comment when originalSnippet is undefined", () => {
    const result = formatCommentWithSuggestion(
      "Some finding",
      "warning",
      "replacement code",
      undefined,
      "added",
      5,
      undefined,
    );
    expect(result).not.toContain("```suggestion");
  });

  it("falls back to plain comment when lineType is undefined", () => {
    const result = formatCommentWithSuggestion(
      "Some finding",
      "warning",
      "replacement code",
      "original code",
      undefined,
      5,
      undefined,
    );
    expect(result).not.toContain("```suggestion");
  });

  it("includes severity in uppercase", () => {
    const result = formatCommentWithSuggestion("Check this", "critical");
    expect(result).toContain("[CRITICAL]");
  });

  it("formats attention severity in uppercase", () => {
    const result = formatCommentWithSuggestion("Important risk", "attention");
    expect(result).toContain("[ATTENTION]");
  });

  it("context line type allows suggestion block", () => {
    const result = formatCommentWithSuggestion(
      "Improve this",
      "info",
      "better code",
      "original code",
      "context",
      20,
      undefined,
    );
    expect(result).toContain("```suggestion:-0+0");
    expect(result).toContain("better code");
  });
});
