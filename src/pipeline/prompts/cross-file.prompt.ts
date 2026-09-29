import type { MergeRequestInfo } from "~/domain/types/code-host.types";
import {
  UNTRUSTED_INPUT_BOUNDARY_INSTRUCTION,
  wrapUntrusted,
} from "~/pipeline/prompts/injection-defense";
import {
  buildJsonOutputInstructions,
  injectPathRules,
  injectProjectRules,
} from "~/pipeline/prompts/prompt-utils";
import {
  buildRuleCatalogInstruction,
  buildRuleIdList,
} from "~/pipeline/prompts/rule-catalog.prompt";

interface FileSummary {
  findingCount: number;
  path: string;
  topSeverity: string | null;
}

function buildCrossFileSystemPrompt(
  projectRules: string | null,
  pathRules: string | null,
): string {
  const schema = JSON.stringify(
    {
      findings: [
        {
          confidence: 0.85,
          file_path: "src/example.ts",
          line_number: 1,
          line_type: "added",
          rule_id: "R-025",
        },
      ],
    },
    null,
    2,
  );

  let prompt = [
    UNTRUSTED_INPUT_BOUNDARY_INSTRUCTION,
    "",
    "You are a senior architect reviewing a merge request for cross-file issues.",
    "",
    "Analyze for:",
    "- Imports from an inner layer to an outer layer, against the dependency direction the project declares (R-025)",
    "- Call sites whose arguments or result usage differ from the callee's current signature or return type (R-026)",
    "",
    "Codebase context — full content of files modified in this MR — is provided in the user message under '## Codebase context'.",
    "Use this context to identify layer-direction violations and call sites that no longer match the callee contract.",
    "Do NOT invent paths outside the MR — only files listed under 'Changed files' may appear in finding `file_path`.",
    "",
    "MR diffs (compact) in the user message list changed files with unified diff snippets and an allowable anchors table per file.",
    "Each finding MUST use file_path, line_number, and line_type that match exactly one row of that file's allowable anchors table in the user message.",
    "Do not emit findings for paths omitted from MR diffs (compact) or listed as omitted without an anchors table.",
    "Purely file-level architecture points with no line anchor — omit the finding or anchor to one concrete table row.",
    "",
    "For findings:",
    '- "file_path" is the affected new file path (must match a path with an anchors table under MR diffs (compact), except omitted paths)',
    "- Only report issues not already caught by per-file review",
    "- Anchor every finding to a file from 'Changed files' — findings on other paths will be dropped",
    "- Return empty findings if no cross-file issues found",
    "",
    buildRuleCatalogInstruction("cross-file"),
    `- rule_id MUST be one of: ${buildRuleIdList("cross-file")}. A finding with any other rule_id is discarded.`,
    "- Output no prose and no code in findings: the text of every finding comes from the rule catalog.",
    '- line_type MUST be one of: "added", "removed", "context".',
    "- confidence rubric (0..1): 0.5 hypothesis grounded in diffs / 0.7 corroborated by another file's diff or context / 0.9 directly demonstrable from cited lines.",
    "",
    buildJsonOutputInstructions(schema),
  ].join("\n");

  if (projectRules) {
    prompt = injectProjectRules(prompt, projectRules);
  }
  if (pathRules) {
    prompt = injectPathRules(prompt, pathRules);
  }

  return prompt;
}

function buildCrossFileUserPrompt(
  mrInfo: MergeRequestInfo,
  fileSummaries: FileSummary[],
  findingSummaries: string,
  mrDiffsCompactSection: string,
  codebaseContext?: string,
): string {
  const fileList = fileSummaries
    .map(
      (f) =>
        `${f.path} — ${f.findingCount} finding(s)${f.topSeverity ? `, top: ${f.topSeverity}` : ""}`,
    )
    .join("\n");

  const parts: string[] = [
    `MR title: ${wrapUntrusted("pr_title", mrInfo.title)}`,
    `Branch: ${mrInfo.sourceBranch} -> ${mrInfo.targetBranch}`,
    mrInfo.description
      ? `Description: ${wrapUntrusted("pr_description", mrInfo.description)}`
      : "",
    "",
    "Changed files:",
    fileList,
  ];

  if (findingSummaries) {
    parts.push("", "Per-file findings summary:", findingSummaries);
  }

  parts.push("", wrapUntrusted("diff", mrDiffsCompactSection));

  if (codebaseContext) {
    parts.push(
      "",
      "## Codebase context",
      wrapUntrusted("codebase", codebaseContext),
    );
  }

  return parts.filter((line, i) => line !== "" || i !== 0).join("\n");
}

export { buildCrossFileSystemPrompt, buildCrossFileUserPrompt };
export type { FileSummary };
