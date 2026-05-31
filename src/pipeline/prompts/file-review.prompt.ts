import { getReviewLanguage } from "~/config/review-language";
import type { MergeRequestInfo } from "~/domain/types/code-host.types";
import type { TextBlock } from "~/domain/types/llm.types";
import { buildAnalysisDisciplineInstruction } from "~/pipeline/prompts/file-review-analysis-discipline";
import {
  buildJsonOutputInstructions,
  injectProjectRules,
} from "~/pipeline/prompts/prompt-utils";

const FILE_REVIEW_FINDINGS_SCHEMA_EXAMPLE = JSON.stringify({
  findings: [
    {
      category: "bug",
      comment: "Description of the issue",
      confidence: 0.9,
      end_line: null,
      file_path: "src/example.ts",
      line_number: 42,
      line_type: "added",
      old_path: null,
      original_snippet: null,
      severity: "warning",
      suggestion: null,
    },
  ],
});

function buildFileReviewAnalysisSystemBlocks(
  projectRules: string | null,
  architectureSnapshot: string | undefined,
  applyCacheControl: boolean,
  language: string = getReviewLanguage(),
): TextBlock[] {
  let text = [
    "You are reviewing one file diff.",
    "Phase 1 (analysis only): output structured markdown or prose.",
    "Cover risks, open questions, and hypotheses tied to the diff; cite lines using L<number> markers from the diff when relevant.",
    "Focus on runtime-impacting issues: correctness, security, performance, architecture boundaries (DDD/hexagonal), and contract/type regressions.",
    "Use tools only when needed to verify imports/contracts before stating a risk.",
    "Severity rubric (use exactly these 5 levels in the extraction phase): critical = data loss, security breach, crash, broken auth/permissions, or production outage; attention = high-confidence bug or contract break with concrete user-visible impact; warning = likely defect, incorrect handling of an edge case, or non-trivial maintainability/perf risk grounded in the diff; info = useful observation or minor risk that does not require action; nitpick = pure polish or style preference.",
    "Pick the lowest level that still describes the real risk. When uncertain between two levels, prefer the lower one.",
    "Style-only or polish issues MUST be info or nitpick — never warning/attention/critical.",
    "Category vocabulary (prefer one of these lowercase tokens; reuse the same token across findings of the same kind so deduplication works): bug, security, performance, architecture, types, contract, error_handling, concurrency, validation, observability, dx, style, best_practice. Do not invent synonyms.",
    "Confidence rubric (0..1): 0.5 = plausible hypothesis grounded in the diff but not verified; 0.7 = consistent with diff and one corroborating signal (tool output, type, neighbouring code); 0.9 = directly demonstrable from diff lines or verified tool output. Use 0.9+ only when you can cite the line or tool result that proves it.",
    "Do not output JSON, fenced JSON code blocks, or a machine-targeted findings list intended for an API.",
    "Never claim that an imported file does not exist unless you first verify it with repository tools.",
    "If you conclude an import path is missing after verification, name the verified repo-relative path you checked in plain language.",
    "Report only issues caused by the current diff or direct interactions.",
    buildAnalysisDisciplineInstruction(language),
    `You MUST write the entire analysis in ${language}.`,
  ].join("\n");
  if (projectRules) {
    text = injectProjectRules(text, projectRules);
  }
  if (architectureSnapshot) {
    text = `${text}\n\n<architecture_snapshot>\n${architectureSnapshot}\n</architecture_snapshot>`;
  }
  const block: TextBlock = applyCacheControl
    ? { cacheControl: { ttl: "1h", type: "ephemeral" }, text, type: "text" }
    : { text, type: "text" };
  return [block];
}

function buildFileReviewExtractionSystemBlocks(
  applyCacheControl: boolean,
  language: string = getReviewLanguage(),
): TextBlock[] {
  const text = [
    `You convert a prior ${language} code-review analysis into a machine-readable findings list.`,
    "Include ONLY issues clearly grounded in the analysis text in the user message. Do not invent or expand new issues.",
    "Each finding MUST use file_path exactly equal to the target file path given in the user message.",
    "The user message includes an allowable anchors table for this diff: each finding MUST use line_number and line_type that match exactly one row in that table for that file_path.",
    "Do not mix a line_number from one anchor row with a line_type from another; if no row fits, omit the finding.",
    "If end_line is provided, both line_number and end_line MUST each match a row in the same table, exist in the same diff hunk, and form a valid inclusive range.",
    "If no exact in-hunk position exists, omit that finding.",
    "Use fields exactly: file_path, old_path (optional), line_number, end_line optional, line_type, confidence (0..1), category, severity, comment, original_snippet optional.",
    'line_type MUST be one of: "added", "removed", "context".',
    'severity MUST be one of: "critical", "attention", "warning", "info", "nitpick". Apply the rubric stated in the analysis-phase system prompt; map polish/style to "info" or "nitpick" only.',
    "category SHOULD reuse one of the documented tokens (bug, security, performance, architecture, types, contract, error_handling, concurrency, validation, observability, dx, style, best_practice). Stick to lowercase snake_case; do not introduce synonyms — duplicate detection depends on stable categories.",
    "confidence MUST follow the rubric in the analysis-phase prompt (0.5 hypothesis / 0.7 corroborated / 0.9 directly demonstrable).",
    "Keep rationale strictly in comment. suggestion must contain only replacement code lines (patch content) with no explanation text.",
    "Provide suggestion only when confidence >= 0.8 and fix is unambiguous; never for removed lines.",
    "When the fix is deleting the selected range, suggestion may be an empty string to produce deletion-only apply suggestion (allowed only with line_type added or context).",
    "Never emit a missing-import-path finding unless the analysis explicitly documents tool verification.",
    "For every missing-file import finding, include a marker in comment: [verified_repo_path: <repo-relative-path>] matching the analysis.",
    buildJsonOutputInstructions(FILE_REVIEW_FINDINGS_SCHEMA_EXAMPLE),
    `You MUST write every finding comment and suggestion in ${language}.`,
  ].join("\n");
  const block: TextBlock = applyCacheControl
    ? { cacheControl: { ttl: "1h", type: "ephemeral" }, text, type: "text" }
    : { text, type: "text" };
  return [block];
}

function buildFileReviewAnalysisUserPrompt(
  mrInfo: MergeRequestInfo,
  diffText: string,
  pathRules: string | null,
  codebaseContext?: string,
  docContext?: string,
): string {
  const parts = [
    `MR: ${mrInfo.title}`,
    `Branch: ${mrInfo.sourceBranch} -> ${mrInfo.targetBranch}`,
    mrInfo.description ? `Description: ${mrInfo.description}` : "",
    "",
    "File diff:",
    diffText,
  ].filter(Boolean);
  if (pathRules) {
    parts.push("", "Path rules:", `<path_rules>\n${pathRules}\n</path_rules>`);
  }
  if (codebaseContext) {
    parts.push("", "Related codebase context:", codebaseContext);
  }
  if (docContext) {
    parts.push("", "Library/API documentation context:", docContext);
  }
  return parts.join("\n");
}

function buildFileReviewExtractionUserPrompt(params: {
  allowableAnchorsText: string;
  analysisText: string;
  filePath: string;
}): string {
  const { allowableAnchorsText, analysisText, filePath } = params;
  return [
    `Target file_path for every finding: ${filePath}`,
    "",
    "Prior analysis:",
    analysisText,
    "",
    "Allowable anchors (closed list; each finding MUST use exactly one line_type + line_number pair from this table):",
    allowableAnchorsText,
  ].join("\n");
}

export {
  buildFileReviewAnalysisSystemBlocks,
  buildFileReviewAnalysisUserPrompt,
  buildFileReviewExtractionSystemBlocks,
  buildFileReviewExtractionUserPrompt,
};
