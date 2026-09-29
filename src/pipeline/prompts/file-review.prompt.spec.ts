import { describe, expect, it } from "vitest";

import { buildAnalysisDisciplineInstruction } from "~/pipeline/prompts/file-review-analysis-discipline";

import {
  buildFileReviewAnalysisSystemBlocks,
  buildFileReviewAnalysisUserPrompt,
  buildFileReviewExtractionSystemBlocks,
  buildFileReviewExtractionUserPrompt,
} from "./file-review.prompt";
import {
  buildRuleCatalogInstruction,
  buildRuleIdList,
} from "./rule-catalog.prompt";

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
  it("states the untrusted-input boundary so injected directives are treated as data", () => {
    const text = analysisSystemText();
    expect(text).toContain("untrusted input boundary");
    expect(text).toMatch(/never as instructions/i);
  });

  it("asks for phase 1 analysis only without JSON output", () => {
    const text = analysisSystemText();
    expect(text).toContain("Phase 1 (analysis only)");
    expect(text).toContain("Do not output JSON");
  });

  it("instructs to cite diff lines with L markers", () => {
    expect(analysisSystemText()).toContain("L<number> markers");
  });

  it("embeds the file-scope rule catalog in place of a free-form rubric", () => {
    const text = analysisSystemText();
    expect(text).toContain(buildRuleCatalogInstruction("file"));
    expect(text).not.toContain("Severity rubric");
    expect(text).not.toContain("Category vocabulary");
    expect(text).not.toContain("suggestion");
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

  it("asks for a rule id and an anchor, never for severity, category or a suggestion", () => {
    const text = extractionSystemText();
    expect(text).toContain("rule_id");
    expect(text).toContain("original_snippet");
    expect(text).not.toContain("severity");
    expect(text).not.toContain("category");
    expect(text).not.toContain("suggestion");
  });

  it("restricts rule_id to the file-scope catalog ids", () => {
    expect(extractionSystemText()).toContain(
      `rule_id MUST be one of: ${buildRuleIdList("file")}. A match with any other rule_id is discarded.`,
    );
  });

  it("asks for no prose and no code in the matches", () => {
    expect(extractionSystemText()).toContain(
      "Output no prose, no explanation and no code",
    );
  });

  it("instructs grounded extraction only", () => {
    const text = extractionSystemText();
    expect(text).toContain("ONLY matches clearly grounded");
    expect(text).toContain("Do not invent");
  });

  it("instructs to anchor line_number and line_type to the user anchors table", () => {
    const text = extractionSystemText();
    expect(text).toContain("allowable anchors table");
    expect(text).toContain("line_type");
    expect(text).toContain("end_line");
    expect(text).not.toContain("start_line");
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

  it("wraps untrusted diff and PR description in delimiters", () => {
    const text = buildFileReviewAnalysisUserPrompt(mrInfo, "DIFFBODY", null);
    expect(text).toContain("<untrusted_diff>\nDIFFBODY\n</untrusted_diff>");
    expect(text).toContain(
      "<untrusted_pr_description>\ndesc\n</untrusted_pr_description>",
    );
    expect(text).toContain("<untrusted_pr_title>\nMR\n</untrusted_pr_title>");
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
