import { getReviewLanguage } from "~/config/review-language";
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

interface FileSummary {
  findingCount: number;
  path: string;
  topSeverity: string | null;
}

function buildCrossFileSystemPrompt(
  projectRules: string | null,
  pathRules: string | null,
  language: string = getReviewLanguage(),
): string {
  const schema = JSON.stringify(
    {
      findings: [
        {
          category: "architecture",
          comment: "Description of cross-file issue",
          confidence: 0.85,
          file_path: "src/example.ts",
          line_number: 1,
          line_type: "added",
          severity: "warning",
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
    "- Architecture violations (controller importing repository directly, wrong layer access)",
    "- Circular dependencies between modules",
    "- Missing error propagation across module boundaries",
    "- Inconsistent patterns across changed files",
    "- Breaking changes to public interfaces",
    "- DDD bounded-context leaks and domain boundary erosion",
    "- Hexagonal dependency direction breaks between ports and adapters",
    "- Type contract drift across modules that can cause runtime regressions",
    "- Dependency or layering problems",
    "",
    "Codebase context — full content of files modified in this MR — is provided in the user message under '## Codebase context'.",
    "Use this context to identify inconsistencies between modified files, contract drift, layering violations, and broken cross-file invariants.",
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
    "- Use balanced strictness: warning+ only for issues with concrete behavior, coupling, security, reliability, or compatibility risk",
    "- Keep style-only or subjective architectural preferences at info/nitpick level",
    '- severity MUST be one of: "critical", "attention", "warning", "info", "nitpick". critical = security breach / data loss / outage; attention = high-confidence cross-file contract break with user-visible impact; warning = concrete behavioural / coupling / compatibility risk grounded in the diffs; info = useful observation; nitpick = subjective preference. Pick the lowest level that still describes the real risk.',
    '- line_type MUST be one of: "added", "removed", "context".',
    "- category SHOULD reuse one of the documented tokens (architecture, contract, types, security, performance, dependency, layering, boundary, error_handling, observability) — lowercase snake_case, no synonyms (duplicate detection across passes is keyed on category).",
    "- confidence rubric (0..1): 0.5 hypothesis grounded in diffs / 0.7 corroborated by another file's diff or context / 0.9 directly demonstrable from cited lines.",
    "- This pass MUST NOT emit suggestion or original_snippet fields — cross-file findings are advisory only; per-file pass owns code suggestions.",
    "",
    "DDD and Hexagonal cross-file checks:",
    "- Domain modules should depend on abstractions, never on infrastructure adapters",
    "- Application services should consume ports/contracts rather than concrete gateways/repositories from other modules",
    "- Adapters must remain on boundaries; avoid adapter-to-adapter coupling across bounded contexts",
    "- Highlight inter-module changes that bypass domain invariants or use-case orchestration",
    "",
    "TypeScript contract checks across files:",
    "- Highlight breaking interface/type changes without compatibility handling",
    "- Highlight broadening types in a way that weakens guarantees between caller and callee",
    "- Highlight new unsafe casts at module boundaries (API, DB, message bus, external SDK)",
    "",
    buildJsonOutputInstructions(schema),
  ].join("\n");

  if (projectRules) {
    prompt = injectProjectRules(prompt, projectRules);
  }
  if (pathRules) {
    prompt = injectPathRules(prompt, pathRules);
  }
  prompt = `${prompt}\n\nYou MUST write all findings and comments in ${language}.`;

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
