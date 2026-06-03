import type { IConfig } from "~/shared/config";
import type { FastifyBaseLogger } from "fastify";

import type { LlmConfigSchema } from "~/config/llm.config";
import type { ILlmClient } from "~/domain/ports/llm.port";
import type {
  ChatMessage,
  LlmOptions,
  LlmResponse,
  ToolCall,
  ToolDefinition,
} from "~/domain/types/llm.types";
import { assertPromptTokenBudget } from "~/infrastructure/llm/estimate-prompt-tokens";

const TIMEOUT_MS = 120_000;
const MAX_RETRIES = 2;
const RETRY_DELAYS_MS = [1000, 2000];
const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504];
const DEFAULT_MAX_TOOL_ROUNDS = 3;
const DEFAULT_NUM_PREDICT = 2048;
const MAX_NUM_PREDICT_ON_RETRY = 800;
const LARGE_PAYLOAD_BYTES = 80_000;
const MAX_CUMULATIVE_PROMPT_TOKENS = 30_000;

interface OllamaMessage {
  content: string;
  role: string;
  tool_calls?: Array<{
    function: { name: string; arguments: Record<string, unknown> };
  }>;
}

interface OllamaResponse {
  eval_count?: number;

  message?: OllamaMessage | undefined;

  prompt_eval_count?: number;
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

function mapToOllamaMessages(
  messages: ChatMessage[],
): Array<{ role: string; content: string }> {
  return messages.map((msg) => {
    if (msg.role === "tool") {
      return { content: msg.content, role: "tool" };
    }

    if (msg.role === "assistant") {
      return { content: msg.content ?? "", role: "assistant" };
    }

    if (msg.role === "system") {
      const content = Array.isArray(msg.content)
        ? msg.content.map((block) => block.text).join("\n")
        : msg.content;
      return { content, role: "system" };
    }

    return { content: msg.content, role: "user" };
  });
}

class OllamaClient implements ILlmClient {
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly apiKey: string | undefined;
  private toolsSupported: boolean | null = null;

  constructor(
    config: IConfig<LlmConfigSchema>,
    private readonly logger: FastifyBaseLogger,
  ) {
    this.baseUrl = config.envs.OLLAMA_BASE_URL;
    this.defaultModel = config.envs.OLLAMA_MODEL;
    this.apiKey = config.envs.OLLAMA_API_KEY;
  }

  async chatCompletion(
    messages: ChatMessage[],
    options?: LlmOptions,
  ): Promise<LlmResponse> {
    const model = options?.model ?? this.defaultModel;
    assertPromptTokenBudget(
      messages,
      options?.tools,
      options?.maxPromptTokensHard,
    );
    const body: Record<string, unknown> = {
      messages: mapToOllamaMessages(messages),
      model,
      options: {
        num_predict: options?.maxTokens ?? DEFAULT_NUM_PREDICT,
        temperature: options?.temperature ?? 0.1,
      },
      stream: false,
    };

    if (options?.responseSchema) {
      body["format"] = options.responseSchema;
    } else if (options?.jsonMode) {
      body["format"] = "json";
    }

    const hasTools = options?.tools && options.tools.length > 0;

    if (hasTools && this.toolsSupported !== false) {
      body["tools"] = options.tools!.map((t) => ({
        function: {
          description: t.description,
          name: t.name,
          parameters: t.parameters,
        },
        type: "function",
      }));
    }

    let data: OllamaResponse;

    try {
      data = await this.fetchWithRetry(body);

      if (hasTools) {
        this.toolsSupported = true;
      }
    } catch (error) {
      if (
        hasTools &&
        this.toolsSupported === null &&
        error instanceof Error &&
        this.isToolsUnsupportedError(error)
      ) {
        this.logger.warn(
          "Ollama does not support tool calls, falling back to plain completion",
        );
        this.toolsSupported = false;
        delete body["tools"];
        data = await this.fetchWithRetry(body);
      } else {
        throw error;
      }
    }

    const toolCalls = this.extractToolCalls(data.message);

    return {
      content: data.message?.content || null,

      toolCalls,
      usage: {
        completionTokens: data.eval_count ?? 0,
        promptTokens: data.prompt_eval_count ?? 0,
      },
    };
  }

  async chatCompletionWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    toolExecutor: (call: ToolCall) => Promise<string>,
    options?: LlmOptions,
  ): Promise<LlmResponse> {
    if (this.toolsSupported === false) {
      this.logger.warn(
        "Ollama tool calls not supported, running single completion without tools",
      );
      return this.chatCompletion(messages, { ...options, tools: undefined });
    }

    const maxRounds = options?.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    const conversation: ChatMessage[] = [...messages];
    const toolCallCache = new Map<string, string>();
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
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

      if (response.toolCalls.length === 0) {
        return {
          content: response.content,
          toolCalls: [],
          usage: {
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
        "Ollama tool loop round",
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
          "Ollama tool-loop cumulative token budget exceeded, early exit",
        );
        return {
          content: response.content,
          toolCalls: [],
          usage: {
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
          this.logger.debug({ name: call.name }, "Ollama tool-call dedup hit");
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
      "Tool loop exhausted before final assistant response",
    );
    return {
      content: null,
      toolCalls: [],
      usage: {
        completionTokens: totalCompletionTokens,
        promptTokens: totalPromptTokens,
        toolCalls: totalToolCalls,
        toolRounds: toolRounds.length,
      },
    };
  }

  private extractToolCalls(message: OllamaMessage | undefined): ToolCall[] {
    if (!message?.tool_calls || message.tool_calls.length === 0) {
      return [];
    }

    return message.tool_calls.map((tc, index) => ({
      arguments: tc.function.arguments,
      id: `ollama-tool-${index}`,
      name: tc.function.name,
    }));
  }

  private isToolsUnsupportedError(error: Error): boolean {
    const msg = error.message.toLowerCase();
    return (
      msg.includes("tool") ||
      msg.includes("400") ||
      msg.includes("422") ||
      msg.includes("not supported")
    );
  }

  private async fetchWithRetry(
    body: Record<string, unknown>,
  ): Promise<OllamaResponse> {
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
        this.logger.debug(`Ollama retry attempt ${attempt} after ${delay}ms`);
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (this.apiKey) {
          headers["Authorization"] = `Bearer ${this.apiKey}`;
        }
        const response = await fetch(`${this.baseUrl}/api/chat`, {
          body: JSON.stringify(requestBody),
          headers,
          method: "POST",
          signal: controller.signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          lastError = new Error(
            `Ollama API error: ${response.status} ${errorText}`,
          );

          if (
            RETRYABLE_STATUS_CODES.includes(response.status) &&
            attempt < retryLimit
          ) {
            continue;
          }

          throw lastError;
        }

        return (await response.json()) as OllamaResponse;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const isNetworkError =
          lastError.name === "AbortError" ||
          lastError.message.includes("fetch failed");

        if (isNetworkError && attempt < retryLimit) {
          continue;
        }

        throw lastError;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw lastError ?? new Error("Ollama API failed after all retries");
  }

  private buildRetryBody(
    body: Record<string, unknown>,
  ): Record<string, unknown> {
    const options =
      typeof body["options"] === "object" && body["options"] !== null
        ? (body["options"] as Record<string, unknown>)
        : {};
    const numPredict =
      typeof options["num_predict"] === "number"
        ? Math.min(options["num_predict"], MAX_NUM_PREDICT_ON_RETRY)
        : MAX_NUM_PREDICT_ON_RETRY;
    return {
      ...body,
      options: {
        ...options,
        num_predict: numPredict,
        temperature: 0,
      },
      tools: undefined,
    };
  }
}

export { OllamaClient };
