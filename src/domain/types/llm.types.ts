type CacheControl = { type: "ephemeral"; ttl: "1h" | "5m" };

type TextBlock = {
  cacheControl?: CacheControl | undefined;
  text: string;
  type: "text";
};

type ChatMessage =
  | { role: "system"; content: string | TextBlock[] }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

interface ToolDefinition {
  description: string;
  name: string;
  parameters: Record<string, unknown>;
}

interface ToolCall {
  arguments: Record<string, unknown>;
  id: string;
  name: string;
}

interface LlmResponse {
  content: string | null;
  toolCalls: ToolCall[];
  usage: {
    cacheCreationInputTokens?: number | undefined;
    cacheReadInputTokens?: number | undefined;
    completionTokens: number;
    promptTokens: number;
    toolCalls?: number | undefined;
    toolRounds?: number | undefined;
  };
}

interface LlmOptions {
  jsonMode?: boolean | undefined;
  maxPromptTokensHard?: number | undefined;
  maxTokens?: number | undefined;
  maxToolRounds?: number | undefined;
  model?: string | undefined;
  reasoning?:
    | {
        effort?: "low" | "medium" | "high" | undefined;
        maxTokens?: number | undefined;
      }
    | undefined;
  responseSchema?: Record<string, unknown> | undefined;
  temperature?: number | undefined;
  tools?: ToolDefinition[] | undefined;
}

export type {
  CacheControl,
  ChatMessage,
  LlmOptions,
  LlmResponse,
  TextBlock,
  ToolCall,
  ToolDefinition,
};
