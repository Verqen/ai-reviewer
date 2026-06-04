import { getReviewLanguage } from "~/config/review-language";
import type { MergeRequestInfo } from "~/domain/types/code-host.types";
import type { ReviewFinding } from "~/domain/types/review.types";
import {
  UNTRUSTED_INPUT_BOUNDARY_INSTRUCTION,
  wrapUntrusted,
} from "~/pipeline/prompts/injection-defense";
import {
  injectPathRules,
  injectProjectRules,
} from "~/pipeline/prompts/prompt-utils";
import { buildReplyCompletionInstruction } from "~/review/reply-completion-instruction";

const DEFAULT_THREAD_PROMPT_TOOL_ROUNDS = 3;

function buildFindingThreadClarificationSystemPrompt(
  projectRules: string | null,
  pathRules: string | null,
  options: {
    language?: string;
    maxToolRounds?: number;
    toolsAvailable: boolean;
  },
): string {
  const maxToolRounds =
    options.maxToolRounds ?? DEFAULT_THREAD_PROMPT_TOOL_ROUNDS;
  const language = options.language ?? getReviewLanguage();
  const toolsBlock = options.toolsAvailable
    ? [
        "Repository tools available: read_file, search_content, list_files, diff_hunk.",
        "Use diff_hunk when the inlined MR diff is truncated or lacks local before/after lines; pass path (newPath), line_number, and line_type consistent with the diff anchors; the tool echoes anchor_used and inclusive baseline_slice/head_slice ranges—cite only within those lines unless you widen context or use read_file.",
        "Use them to verify fixes, inspect referenced code, or locate definitions the developer asks about anywhere in the repository — not only files inside the MR diff.",
        `Use tools sparingly (max ${String(maxToolRounds)} rounds). Prefer read_file when you already know the exact path; use search_content/list_files to locate definitions first.`,
        `Stop calling tools as soon as the diff and tool outputs are enough to answer; do not run an extra search or read_file just in case.`,
        `After at most ${String(maxToolRounds)} rounds you must finish: on the final round emit only user-visible ${language} markdown and no tool calls. Do not loop on tools.`,
        `If a tool returns no results, fails, or yields ambiguous output, say so explicitly in your reply; do not infer the existence or absence of code from missing evidence and never claim to have checked a file you did not actually load.`,
      ].join(" ")
    : [
        "You do NOT have repository tools.",
        "If inspecting current files is required, briefly say what you cannot see and infer only from diff and thread text.",
      ].join(" ");
  let prompt = [
    UNTRUSTED_INPUT_BOUNDARY_INSTRUCTION,
    "",
    "You continue a SINGLE inline review thread tied to ONE bot finding on THIS merge request.",
    "Respond to the developer's latest message.",
    "",
    "The finding shown below is the primary subject of this thread, but the developer may ask follow-up questions about any file in the repository (e.g. 'where is X defined', 'how is Y used elsewhere'). Answer those by looking up concrete file paths and line numbers using repository tools — do NOT refuse with 'out of MR scope'.",
    "If a lookup returns nothing or the result is ambiguous, say so explicitly instead of guessing. Never invent files, identifiers or line numbers.",
    `Reply in ${language}. Be concise.`,
    "",
    toolsBlock,
  ].join("\n");

  if (projectRules) {
    prompt = injectProjectRules(prompt, projectRules);
  }
  if (pathRules) {
    prompt = injectPathRules(prompt, pathRules);
  }
  return prompt;
}

interface FindingThreadPromptParams {
  appendToolsCompletionInstruction?: boolean | undefined;
  architectureSnapshot?: string | undefined;
  developerNote: string;
  diffText: string;
  finding: ReviewFinding;
  language?: string | undefined;
  mrInfo: MergeRequestInfo;
  priorFindingsSummary?: string | undefined;
  threadSection: string;
}

function buildFindingThreadClarificationUserPrompt(
  params: FindingThreadPromptParams,
): string {
  const {
    appendToolsCompletionInstruction,
    architectureSnapshot,
    developerNote,
    diffText,
    finding,
    language,
    mrInfo,
    priorFindingsSummary,
    threadSection,
  } = params;
  const resolvedLanguage = language ?? getReviewLanguage();
  const location = finding.endLineNumber
    ? `${finding.filePath}:${finding.lineNumber}-${finding.endLineNumber}`
    : `${finding.filePath}:${finding.lineNumber}`;

  const excerptBlock = finding.lineExcerpt
    ? `\nStored excerpt from review (may be outdated):\n\`\`\`\n${finding.lineExcerpt}\n\`\`\`\n`
    : "";

  const suggestionBlock = finding.suggestion
    ? `\nPreviously suggested fix:\n\`\`\`\n${finding.suggestion}\n\`\`\`\n`
    : "";

  const archBlock =
    architectureSnapshot && architectureSnapshot.trim().length > 0
      ? `Architecture snapshot (baseline):\n${architectureSnapshot}\n`
      : "";
  const priorBlock =
    priorFindingsSummary && priorFindingsSummary.trim().length > 0
      ? `${priorFindingsSummary}\n`
      : "";
  const descriptionLine = mrInfo.description
    ? `Description: ${wrapUntrusted("pr_description", mrInfo.description)}`
    : "";
  const threadBlock = threadSection
    ? wrapUntrusted("thread", threadSection)
    : "";
  const base = [
    `MR: ${wrapUntrusted("pr_title", mrInfo.title)}`,
    `Branch: ${mrInfo.sourceBranch} -> ${mrInfo.targetBranch}`,
    descriptionLine,
    "",
    archBlock,
    priorBlock,
    "Diff (MR):",
    wrapUntrusted("diff", diffText),
    "",
    `Finding location: ${location}`,
    `Original bot comment: "${finding.comment}"`,
    excerptBlock,
    suggestionBlock,
    threadBlock,
    "",
    `Developer's latest message:`,
    wrapUntrusted("developer_message", developerNote),
  ]
    .filter(Boolean)
    .join("\n");
  if (appendToolsCompletionInstruction === true) {
    return `${base}\n\n${buildReplyCompletionInstruction(resolvedLanguage)}`;
  }
  return base;
}

export { buildFindingThreadClarificationSystemPrompt };
export { buildFindingThreadClarificationUserPrompt };
export type { FindingThreadPromptParams };
