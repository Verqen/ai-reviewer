import { getReviewLanguage } from "~/config/review-language";
import type { MergeRequestInfo } from "~/domain/types/code-host.types";
import type { TextBlock } from "~/domain/types/llm.types";
import { buildAnalysisDisciplineInstruction } from "~/pipeline/prompts/file-review-analysis-discipline";
import {
  UNTRUSTED_INPUT_BOUNDARY_INSTRUCTION,
  wrapUntrusted,
} from "~/pipeline/prompts/injection-defense";
import {
  buildJsonOutputInstructions,
  injectProjectRules,
} from "~/pipeline/prompts/prompt-utils";
import {
  buildRuleCatalogInstruction,
  buildRuleIdList,
} from "~/pipeline/prompts/rule-catalog.prompt";

const FILE_REVIEW_FINDINGS_SCHEMA_EXAMPLE = JSON.stringify({
  findings: [
    {
      confidence: 0.9,
      end_line: null,
      file_path: "src/example.ts",
      line_number: 42,
      line_type: "added",
      old_path: null,
      original_snippet: null,
      rule_id: "R-013",
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
    UNTRUSTED_INPUT_BOUNDARY_INSTRUCTION,
    "You are reviewing one file diff.",
    "Phase 1 (analysis only): output structured markdown or prose.",
    "Cover risks, open questions, and hypotheses tied to the diff; cite lines using L<number> markers from the diff when relevant.",
    buildRuleCatalogInstruction("file"),
    "Use tools only when needed to verify imports/contracts before stating a risk.",
    "Confidence rubric (0..1): 0.5 = plausible hypothesis grounded in the diff but not verified; 0.7 = consistent with diff and one corroborating signal (tool output, type, neighbouring code); 0.9 = directly demonstrable from diff lines or verified tool output. Use 0.9+ only when you can cite the line or tool result that proves it.",
    "Do not output JSON, fenced JSON code blocks, or a machine-targeted findings list intended for an API.",
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
    `You convert a prior ${language} code-review analysis into a machine-readable list of rule matches.`,
    "Include ONLY matches clearly grounded in the analysis text in the user message. Do not invent or expand new matches.",
    "Each match MUST use file_path exactly equal to the target file path given in the user message.",
    "The user message includes an allowable anchors table for this diff: each match MUST use line_number and line_type that match exactly one row in that table for that file_path.",
    "Do not mix a line_number from one anchor row with a line_type from another; if no row fits, omit the match.",
    "If end_line is provided, both line_number and end_line MUST each match a row in the same table, exist in the same diff hunk, and form a valid inclusive range.",
    "If no exact in-hunk position exists, omit that match.",
    "Use fields exactly: rule_id, file_path, old_path (optional), line_number, end_line (optional), line_type, confidence (0..1), original_snippet (optional).",
    `rule_id MUST be one of: ${buildRuleIdList("file")}. A match with any other rule_id is discarded.`,
    'line_type MUST be one of: "added", "removed", "context".',
    "confidence MUST follow the rubric in the analysis-phase prompt (0.5 hypothesis / 0.7 corroborated / 0.9 directly demonstrable).",
    "Output no prose, no explanation and no code: the text of every match comes from the rule catalog.",
    buildJsonOutputInstructions(FILE_REVIEW_FINDINGS_SCHEMA_EXAMPLE),
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
): string {
  const parts = [
    `MR title: ${wrapUntrusted("pr_title", mrInfo.title)}`,
    `Branch: ${mrInfo.sourceBranch} -> ${mrInfo.targetBranch}`,
    mrInfo.description
      ? `Description: ${wrapUntrusted("pr_description", mrInfo.description)}`
      : "",
    "",
    "File diff:",
    wrapUntrusted("diff", diffText),
  ].filter(Boolean);
  if (pathRules) {
    parts.push("", "Path rules:", `<path_rules>\n${pathRules}\n</path_rules>`);
  }
  if (codebaseContext) {
    parts.push(
      "",
      "Related codebase context:",
      wrapUntrusted("codebase", codebaseContext),
    );
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
