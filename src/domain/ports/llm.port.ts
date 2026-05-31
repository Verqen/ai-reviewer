import type {
  ChatMessage,
  LlmOptions,
  LlmResponse,
  ToolCall,
  ToolDefinition,
} from "~/domain/types/llm.types";

interface ILlmClient {
  chatCompletion(
    messages: ChatMessage[],
    options?: LlmOptions,
  ): Promise<LlmResponse>;

  chatCompletionWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    toolExecutor: (call: ToolCall) => Promise<string>,
    options?: LlmOptions,
  ): Promise<LlmResponse>;
}

export type { ILlmClient };
