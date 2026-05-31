import { getReviewLanguage } from "~/config/review-language";
import {
  injectPathRules,
  injectProjectRules,
} from "~/pipeline/prompts/prompt-utils";

const DEFAULT_COMMENT_PROMPT_TOOL_ROUNDS = 2;

function buildBaseCommentSystemPrompt(
  toolsAvailable: boolean,
  maxToolRounds: number,
  language: string,
): string {
  const toolsBlock = toolsAvailable
    ? [
        `You have tools to inspect the repository: read_file, search_content, list_files, diff_hunk. Use them sparingly (max ${String(maxToolRounds)} tool rounds) when the developer's question requires checking another file (e.g. middleware setup, imports, sibling code). Use diff_hunk when the MR diff text in the prompt is truncated or you need a precise baseline vs head slice around an anchor without reading whole files; each diff_hunk result states anchor_used and inclusive baseline_slice/head_slice line ranges—ground citations in those spans.`,
        `Stop calling tools as soon as the diff and tool outputs are enough to answer; do not run an extra search or read_file just in case.`,
        `After at most ${String(maxToolRounds)} tool rounds you must finish: on the final round emit only user-visible ${language} markdown and no tool calls. Do not loop on tools.`,
        `Never claim to have checked a file or symbol you did not actually load with a tool; if a tool returns nothing, fails, or gives ambiguous output, say so explicitly in the answer instead of inferring or guessing.`,
      ].join(" ")
    : [
        "You do NOT have tools and you cannot read any file other than the diff already provided.",
        `If the developer's question requires inspecting another file (e.g. 'is middleware connected in app.ts?'), say HONESTLY in ${language} that you cannot read that file and ask the developer to verify it themselves.`,
        "Never claim to have checked something you have not. Never give layered 'check this, then check that' guidance — be direct and admit when info is unavailable.",
      ].join(" ");

  return [
    "You are a helpful code review assistant. A developer tagged you in a merge request comment.",
    "Answer their question based on the MR diff and context. Prioritize DDD and Hexagonal Architecture boundaries, strict TypeScript type safety, and project architectural consistency.",
    "When discussing severity, use balanced strictness: escalate only when there is concrete risk to behavior, security, reliability, performance, or contract stability. Be concise and specific.",
    toolsBlock,
    `Respond in plain markdown, not JSON. You MUST write your response in ${language}.`,
  ].join(" ");
}

function buildCommentSystemPrompt(
  projectRules: string | null,
  pathRules: string | null,
  options: {
    language?: string;
    maxToolRounds?: number;
    toolsAvailable: boolean;
  } = {
    maxToolRounds: DEFAULT_COMMENT_PROMPT_TOOL_ROUNDS,
    toolsAvailable: false,
  },
): string {
  const maxToolRounds =
    options.maxToolRounds ?? DEFAULT_COMMENT_PROMPT_TOOL_ROUNDS;
  const language = options.language ?? getReviewLanguage();
  let prompt: string = buildBaseCommentSystemPrompt(
    options.toolsAvailable,
    maxToolRounds,
    language,
  );
  if (projectRules) {
    prompt = injectProjectRules(prompt, projectRules);
  }
  if (pathRules) {
    prompt = injectPathRules(prompt, pathRules);
  }
  return prompt;
}

export { buildCommentSystemPrompt };
