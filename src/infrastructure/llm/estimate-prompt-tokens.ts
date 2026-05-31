import type { ChatMessage, ToolDefinition } from "~/domain/types/llm.types";

const APPROX_CHARS_PER_TOKEN = 4;

function extractMessageText(msg: ChatMessage): string {
  if (msg.role === "tool") return msg.content;
  if (msg.role === "assistant") return msg.content ?? "";
  if (msg.role === "user") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map((block) => block.text).join("\n");
  }
  return msg.content;
}

function estimatePromptTokens(
  messages: ChatMessage[],
  tools?: ToolDefinition[]
): number {
  const messageChars = messages.reduce(
    (acc, msg) => acc + extractMessageText(msg).length,
    0
  );
  const toolChars =
    tools && tools.length > 0 ? JSON.stringify(tools).length : 0;
  return Math.ceil((messageChars + toolChars) / APPROX_CHARS_PER_TOKEN);
}

class PromptTokenBudgetExceededError extends Error {
  constructor(
    public readonly estimatedTokens: number,
    public readonly hardLimit: number
  ) {
    super(
      `Estimated prompt tokens ${estimatedTokens} exceed hard limit ${hardLimit}`
    );
    this.name = "PromptTokenBudgetExceededError";
  }
}

function assertPromptTokenBudget(
  messages: ChatMessage[],
  tools: ToolDefinition[] | undefined,
  hardLimit: number | undefined
): void {
  if (hardLimit === undefined) return;
  const estimated = estimatePromptTokens(messages, tools);
  if (estimated > hardLimit) {
    throw new PromptTokenBudgetExceededError(estimated, hardLimit);
  }
}

export {
  assertPromptTokenBudget,
  estimatePromptTokens,
  PromptTokenBudgetExceededError,
};
