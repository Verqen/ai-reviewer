import type { ILlmClient } from "~/domain/ports/llm.port";
import type {
  ChatMessage,
  LlmOptions,
  LlmResponse,
  ToolCall,
  ToolDefinition,
} from "~/domain/types/llm.types";

interface MockLlmClientOptions {
  defaultContent?: string;
  responses?: LlmResponse[];
}

interface MockLlmClientCalls {
  chatCompletion: Array<[ChatMessage[], LlmOptions | undefined]>;
  chatCompletionWithTools: Array<
    [ChatMessage[], ToolDefinition[], LlmOptions | undefined]
  >;
}

function createMockLlmClient(options: MockLlmClientOptions = {}): ILlmClient & {
  calls: MockLlmClientCalls;
} {
  const calls: MockLlmClientCalls = {
    chatCompletion: [],
    chatCompletionWithTools: [],
  };

  const responseQueue = [...(options.responses ?? [])];
  const defaultResponse: LlmResponse = {
    content: options.defaultContent ?? "",
    toolCalls: [],
    usage: { completionTokens: 20, promptTokens: 10 },
  };

  function nextResponse(): LlmResponse {
    return responseQueue.shift() ?? defaultResponse;
  }

  return {
    calls,

    chatCompletion(
      messages: ChatMessage[],
      opts?: LlmOptions
    ): Promise<LlmResponse> {
      calls.chatCompletion.push([messages, opts]);
      return Promise.resolve(nextResponse());
    },

    chatCompletionWithTools(
      messages: ChatMessage[],
      tools: ToolDefinition[],
      _toolExecutor: (call: ToolCall) => Promise<string>,
      opts?: LlmOptions
    ): Promise<LlmResponse> {
      calls.chatCompletionWithTools.push([messages, tools, opts]);
      return Promise.resolve(nextResponse());
    },
  };
}

export { createMockLlmClient };
export type { MockLlmClientCalls, MockLlmClientOptions };
