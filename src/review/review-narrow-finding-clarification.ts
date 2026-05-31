import { getReviewLanguage } from "~/config/review-language";
import type { ILlmClient } from "~/domain/ports/llm.port";
import type { ChatMessage } from "~/domain/types/llm.types";
import type { ReviewFinding } from "~/domain/types/review.types";

const THREAD_REPLY_PROMPT_TOKEN_HARD_LIMIT = 6_000;
const CLARIFICATION_REPLY_MAX_TOKENS = 400;
const CLARIFICATION_REPLY_TEMPERATURE = 0;
const CLARIFICATION_REPLY_FALLBACK =
  "Could not generate a reply due to context limits. Please refine the question and tie it directly to the discussed line.";

async function runNarrowFindingClarification(
  llm: ILlmClient,
  finding: ReviewFinding,
  developerNote: string,
  language: string = getReviewLanguage(),
): Promise<string> {
  const location = finding.endLineNumber
    ? `${finding.filePath}:${finding.lineNumber}-${finding.endLineNumber}`
    : `${finding.filePath}:${finding.lineNumber}`;

  const excerptBlock = finding.lineExcerpt
    ? `\nReferenced code (may be outdated):\n\`\`\`\n${finding.lineExcerpt}\n\`\`\`\n`
    : "";

  const suggestionBlock = finding.suggestion
    ? `\nPreviously suggested fix:\n\`\`\`\n${finding.suggestion}\n\`\`\`\n`
    : "";

  const systemPrompt = [
    "You answer a developer's follow-up question in a code-review thread.",
    "You have access ONLY to: the original reviewer comment, an optional code excerpt, an optional suggested fix, and the developer's reply.",
    "",
    "STRICT RULES:",
    "- Answer the developer's specific question about THIS comment.",
    "- Maximum 3 short sentences. No preamble. No restatement of the comment.",
    "- Do NOT discuss other files, the whole merge request, project structure, frameworks, or general best practices.",
    "- If the question asks for a fix, give a one- or two-line code snippet or describe the change in one sentence.",
    `- Reply in ${language}.`,
  ].join("\n");

  const userPrompt = [
    `Reviewer comment at ${location}:`,
    `"${finding.comment}"`,
    excerptBlock,
    suggestionBlock,
    `Developer reply:`,
    `"${developerNote}"`,
  ].join("\n");

  const messages: ChatMessage[] = [
    { content: [{ text: systemPrompt, type: "text" }], role: "system" },
    { content: userPrompt, role: "user" },
  ];

  const response = await llm.chatCompletion(messages, {
    maxPromptTokensHard: THREAD_REPLY_PROMPT_TOKEN_HARD_LIMIT,
    maxTokens: CLARIFICATION_REPLY_MAX_TOKENS,
    reasoning: { effort: "low" },
    temperature: CLARIFICATION_REPLY_TEMPERATURE,
  });

  const content = response.content?.trim();
  if (!content) return CLARIFICATION_REPLY_FALLBACK;
  return content;
}

export { runNarrowFindingClarification };
