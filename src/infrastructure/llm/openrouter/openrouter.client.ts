import type { IConfig } from "~/shared/config";
import type { FastifyBaseLogger } from "fastify";

import type { OpenRouterConfigSchema } from "~/config/openrouter.config";
import type { ILlmClient } from "~/domain/ports/llm.port";
import type {
  ChatMessage,
  LlmOptions,
  LlmResponse,
  ToolCall,
  ToolDefinition,
} from "~/domain/types/llm.types";
import { assertPromptTokenBudget } from "~/infrastructure/llm/estimate-prompt-tokens";

const API_URL = "https://openrouter.ai/api/v1/chat/completions";
const TIMEOUT_MS = 60_000;
const MAX_RETRIES = 2;
const RETRY_DELAYS_MS = [1000, 2000];
const RETRYABLE_STATUS_CODES = [429, 502, 503, 504];
const DEFAULT_MAX_TOOL_ROUNDS = 3;
const MAX_TOKENS_ON_RETRY = 800;
const LARGE_PAYLOAD_BYTES = 80_000;
const MAX_CUMULATIVE_PROMPT_TOKENS = 30_000;

interface OpenRouterToolCall {
  function: {
    name: string;
    arguments: string;
  };
  id: string;
}

interface OpenRouterMessage {
  content: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
  tool_calls?: OpenRouterToolCall[];
}

interface OpenRouterUsage {
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  completion_tokens: number;
  prompt_tokens: number;
}

interface OpenRouterResponse {
  choices: Array<{ message: OpenRouterMessage }>;
  usage?: OpenRouterUsage;
}

function mapToOpenRouterMessages(
  messages: ChatMessage[]
): Array<Record<string, unknown>> {
  return messages.map((msg) => {
    if (msg.role === "tool") {
      return {
        content: msg.content,
        role: "tool",
        tool_call_id: msg.toolCallId,
      };
    }

    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      return {
        content: msg.content,
        role: "assistant",
        tool_calls: msg.toolCalls.map((tc) => ({
          function: {
            arguments: JSON.stringify(tc.arguments),
            name: tc.name,
          },
          id: tc.id,
          type: "function",
        })),
      };
    }

    if (msg.role === "system" && Array.isArray(msg.content)) {
      return {
        content: msg.content.map((block) => ({
          text: block.text,
          type: "text",
          ...(block.cacheControl ? { cache_control: block.cacheControl } : {}),
        })),
        role: "system",
      };
    }

    return { content: "content" in msg ? msg.content : null, role: msg.role };
  });
}

function mapToolDefinitions(
  tools: ToolDefinition[]
): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    function: {
      description: t.description,
      name: t.name,
      parameters: t.parameters,
    },
    type: "function",
  }));
}

function buildToolCallCacheKey(call: ToolCall): string {
  const sortedArgs = Object.keys(call.arguments)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = call.arguments[key];
      return acc;
    }, {});
  return `${call.name}:${JSON.stringify(sortedArgs)}`;
}

function parseToolCalls(raw: OpenRouterToolCall[]): ToolCall[] {
  return raw.map((tc) => {
    let args: Record<string, unknown> = {};

    try {
      args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
    } catch {
      args = {};
    }

    return { arguments: args, id: tc.id, name: tc.function.name };
  });
}

class OpenRouterClient implements ILlmClient {
  private readonly apiKey: string;
  private readonly defaultModel: string;

  constructor(
    config: IConfig<OpenRouterConfigSchema>,
    private readonly logger: FastifyBaseLogger
  ) {
    this.apiKey = config.envs.OPENROUTER_API_KEY;
    this.defaultModel = config.envs.OPENROUTER_MODEL;
  }

  async chatCompletion(
    messages: ChatMessage[],
    options?: LlmOptions
  ): Promise<LlmResponse> {
    const model = options?.model ?? this.defaultModel;
    assertPromptTokenBudget(
      messages,
      options?.tools,
      options?.maxPromptTokensHard
    );
    const body: Record<string, unknown> = {
      messages: mapToOpenRouterMessages(messages),
      model,
    };

    if (options?.responseSchema) {
      body["response_format"] = {
        json_schema: {
          name: "response",
          schema: options.responseSchema,
          strict: true,
        },
        type: "json_schema",
      };
    } else if (options?.jsonMode) {
      body["response_format"] = { type: "json_object" };
    }
    if (options?.maxTokens !== undefined) {
      body["max_tokens"] = options.maxTokens;
    }
    if (options?.temperature !== undefined) {
      body["temperature"] = options.temperature;
    }
    if (options?.reasoning) {
      body["reasoning"] = {
        effort: options.reasoning.effort ?? "low",
        ...(options.reasoning.maxTokens !== undefined
          ? { max_tokens: options.reasoning.maxTokens }
          : {}),
      };
    }

    if (options?.tools && options.tools.length > 0) {
      body["tools"] = mapToolDefinitions(options.tools);
    }

    const data = await this.fetchWithRetry(body);
    const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
    if (!choice) {
      this.logger.warn(
        { rawData: JSON.stringify(data).slice(0, 300) },
        "OpenRouter returned response with no choices"
      );
    }
    const toolCalls = choice?.message.tool_calls
      ? parseToolCalls(choice.message.tool_calls)
      : [];

    // Reasoning models (e.g. minimax, deepseek-r1) usually put final text in content,
    // but if content is null they may emit it via reasoning_content / reasoning.
    const rawContent =
      choice?.message.content ??
      choice?.message.reasoning_content ??
      choice?.message.reasoning ??
      null;
    if (
      choice?.message.content === null &&
      (choice.message.reasoning_content ?? choice.message.reasoning) !== null
    ) {
      this.logger.debug(
        { hasReasoning: true },
        "OpenRouter response had null content; falling back to reasoning channel"
      );
    }

    return {
      content: rawContent,
      toolCalls,
      usage: {
        cacheCreationInputTokens: data.usage?.cache_creation_input_tokens,
        cacheReadInputTokens: data.usage?.cache_read_input_tokens,
        completionTokens: data.usage?.completion_tokens ?? 0,
        promptTokens: data.usage?.prompt_tokens ?? 0,
      },
    };
  }

  async chatCompletionWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    toolExecutor: (call: ToolCall) => Promise<string>,
    options?: LlmOptions
  ): Promise<LlmResponse> {
    const maxRounds = options?.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    const conversation: ChatMessage[] = [...messages];
    const toolCallCache = new Map<string, string>();
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalCacheCreation = 0;
    let totalCacheRead = 0;
    let totalToolCalls = 0;

    const toolRoundOptions: LlmOptions = {
      ...options,
      jsonMode: undefined,
      responseSchema: undefined,
    };

    const toolRounds: string[][] = [];

    for (let round = 0; round < maxRounds; round++) {
      const response = await this.chatCompletion(conversation, {
        ...toolRoundOptions,
        tools,
      });

      totalPromptTokens += response.usage.promptTokens;
      totalCompletionTokens += response.usage.completionTokens;
      totalCacheCreation += response.usage.cacheCreationInputTokens ?? 0;
      totalCacheRead += response.usage.cacheReadInputTokens ?? 0;

      if (response.toolCalls.length === 0) {
        return {
          content: response.content,
          toolCalls: [],
          usage: {
            cacheCreationInputTokens: totalCacheCreation || undefined,
            cacheReadInputTokens: totalCacheRead || undefined,
            completionTokens: totalCompletionTokens,
            promptTokens: totalPromptTokens,
            toolCalls: totalToolCalls,
            toolRounds: toolRounds.length,
          },
        };
      }

      const roundToolNames = response.toolCalls.map((call) => call.name);
      toolRounds.push(roundToolNames);
      totalToolCalls += response.toolCalls.length;
      this.logger.info(
        {
          maxRounds,
          model: options?.model,
          round,
          toolNames: roundToolNames,
        },
        "OpenRouter tool loop round"
      );

      if (totalPromptTokens >= MAX_CUMULATIVE_PROMPT_TOKENS) {
        this.logger.warn(
          {
            limit: MAX_CUMULATIVE_PROMPT_TOKENS,
            model: options?.model,
            round,
            toolRounds,
            totalPromptTokens,
          },
          "OpenRouter tool-loop cumulative token budget exceeded, early exit"
        );
        return {
          content: response.content,
          toolCalls: [],
          usage: {
            cacheCreationInputTokens: totalCacheCreation || undefined,
            cacheReadInputTokens: totalCacheRead || undefined,
            completionTokens: totalCompletionTokens,
            promptTokens: totalPromptTokens,
            toolCalls: totalToolCalls,
            toolRounds: toolRounds.length,
          },
        };
      }

      conversation.push({
        content: response.content,
        role: "assistant",
        toolCalls: response.toolCalls,
      });

      for (const call of response.toolCalls) {
        const cacheKey = buildToolCallCacheKey(call);
        const cached = toolCallCache.get(cacheKey);
        const result = cached ?? (await toolExecutor(call));
        if (cached === undefined) {
          toolCallCache.set(cacheKey, result);
        } else {
          this.logger.debug(
            { name: call.name },
            "OpenRouter tool-call dedup hit"
          );
        }
        conversation.push({
          content: result,
          role: "tool",
          toolCallId: call.id,
        });
      }
    }

    this.logger.warn(
      { maxRounds, model: options?.model, toolRounds },
      "Tool loop exhausted before final assistant response"
    );
    return {
      content: null,
      toolCalls: [],
      usage: {
        cacheCreationInputTokens: totalCacheCreation || undefined,
        cacheReadInputTokens: totalCacheRead || undefined,
        completionTokens: totalCompletionTokens,
        promptTokens: totalPromptTokens,
        toolCalls: totalToolCalls,
        toolRounds: toolRounds.length,
      },
    };
  }

  private async fetchWithRetry(
    body: Record<string, unknown>
  ): Promise<OpenRouterResponse> {
    let lastError: Error | null = null;
    const payloadSize = JSON.stringify(body).length;
    const isLargePayload = payloadSize >= LARGE_PAYLOAD_BYTES;
    const retryLimit = isLargePayload ? 1 : MAX_RETRIES;
    let requestBody: Record<string, unknown> = body;

    for (let attempt = 0; attempt <= retryLimit; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_DELAYS_MS[attempt - 1] ?? 2000;
        if (attempt === 1 && isLargePayload) {
          requestBody = this.buildRetryBody(requestBody);
        }
        this.logger.debug(
          `OpenRouter retry attempt ${attempt} after ${delay}ms`
        );
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const response = await fetch(API_URL, {
          body: JSON.stringify(requestBody),
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          method: "POST",
          signal: controller.signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          this.logger.error(
            `OpenRouter API error: ${response.status} ${errorText}`
          );
          lastError = new Error(`OpenRouter API error: ${response.status}`);

          if (
            RETRYABLE_STATUS_CODES.includes(response.status) &&
            attempt < retryLimit
          ) {
            continue;
          }

          throw lastError;
        }

        return (await response.json()) as OpenRouterResponse;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const isNetworkError =
          lastError.name === "AbortError" ||
          lastError.message.includes("fetch failed");

        if (isNetworkError && attempt < retryLimit) {
          continue;
        }

        if (!isNetworkError) {
          throw lastError;
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw lastError ?? new Error("OpenRouter API failed after all retries");
  }

  private buildRetryBody(
    body: Record<string, unknown>
  ): Record<string, unknown> {
    const maxTokens =
      typeof body["max_tokens"] === "number"
        ? Math.min(body["max_tokens"], MAX_TOKENS_ON_RETRY)
        : MAX_TOKENS_ON_RETRY;
    return {
      ...body,
      max_tokens: maxTokens,
      reasoning: { effort: "low" },
      tools: undefined,
    };
  }
}

export { OpenRouterClient };
