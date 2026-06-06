import type { IConfig } from "~/shared/config";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LlmConfigSchema } from "~/config/llm.config";
import type { ChatMessage } from "~/domain/types/llm.types";
import { OllamaClient } from "~/infrastructure/llm/ollama/ollama.client";

interface OllamaRequestBody {
  format?: string;
  messages: unknown[];
  model: string;
  options?: { num_predict?: number };
  stream: boolean;
  tools?: unknown[];
}

function createMockConfig(
  overrides: Partial<LlmConfigSchema> = {},
): IConfig<LlmConfigSchema> {
  return {
    envs: {
      LLM_PROVIDER: "ollama",
      OLLAMA_BASE_URL: "http://localhost:11434",
      OLLAMA_MODEL: "qwen3:8b",
      OLLAMA_TRIAGE_MODEL: "qwen3:8b",
      ...overrides,
    },
  };
}

const mockLogger = {
  child: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  info: vi.fn(),
  level: "info",
  silent: vi.fn(),
  trace: vi.fn(),
  warn: vi.fn(),
} as unknown as FastifyBaseLogger;

describe("OllamaClient", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends correct request format", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          eval_count: 10,
          message: { content: "Hello!", role: "assistant" },
          prompt_eval_count: 5,
        }),
      ok: true,
    });

    vi.stubGlobal("fetch", fetchMock);

    const client = new OllamaClient(createMockConfig(), mockLogger);
    const messages: ChatMessage[] = [{ content: "Hi", role: "user" }];

    await client.chatCompletion(messages);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:11434/api/chat",
      expect.objectContaining({
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    );

    const callArgs = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(callArgs[1].body) as OllamaRequestBody;
    expect(body.model).toBe("qwen3:8b");
    expect(body.stream).toBe(false);
    expect(body.messages).toHaveLength(1);
  });

  it("maps usage fields correctly", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          eval_count: 20,
          message: { content: "Response", role: "assistant" },
          prompt_eval_count: 15,
        }),
      ok: true,
    });

    vi.stubGlobal("fetch", fetchMock);

    const client = new OllamaClient(createMockConfig(), mockLogger);
    const result = await client.chatCompletion([
      { content: "test", role: "user" },
    ]);

    expect(result.usage.completionTokens).toBe(20);
    expect(result.usage.promptTokens).toBe(15);
  });

  it("uses model override from options", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          eval_count: 1,
          message: { content: "ok", role: "assistant" },
          prompt_eval_count: 1,
        }),
      ok: true,
    });

    vi.stubGlobal("fetch", fetchMock);

    const client = new OllamaClient(createMockConfig(), mockLogger);
    await client.chatCompletion([{ content: "test", role: "user" }], {
      model: "llama3:8b",
    });

    const callArgs = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(callArgs[1].body) as OllamaRequestBody;
    expect(body.model).toBe("llama3:8b");
  });

  it("enables JSON mode when jsonMode is true", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          eval_count: 1,
          message: { content: "{}", role: "assistant" },
          prompt_eval_count: 1,
        }),
      ok: true,
    });

    vi.stubGlobal("fetch", fetchMock);

    const client = new OllamaClient(createMockConfig(), mockLogger);
    await client.chatCompletion([{ content: "test", role: "user" }], {
      jsonMode: true,
    });

    const callArgs = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(callArgs[1].body) as OllamaRequestBody;
    expect(body.format).toBe("json");
  });

  it("returns null content when response content is empty", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          eval_count: 0,
          message: { content: "", role: "assistant" },
          prompt_eval_count: 0,
        }),
      ok: true,
    });

    vi.stubGlobal("fetch", fetchMock);

    const client = new OllamaClient(createMockConfig(), mockLogger);
    const result = await client.chatCompletion([
      { content: "test", role: "user" },
    ]);

    expect(result.content).toBeNull();
  });

  it("throws on non-retryable HTTP error", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve("Bad Request"),
    });

    vi.stubGlobal("fetch", fetchMock);

    const client = new OllamaClient(createMockConfig(), mockLogger);

    await expect(
      client.chatCompletion([{ content: "test", role: "user" }]),
    ).rejects.toThrow("Ollama API error: 400");
  });

  it("returns null and warns when tool rounds are exhausted", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            eval_count: 11,
            message: {
              content: "",
              role: "assistant",
              tool_calls: [
                {
                  function: { arguments: { path: "a.ts" }, name: "read_file" },
                },
              ],
            },
            prompt_eval_count: 7,
          }),
        ok: true,
      })
      .mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            eval_count: 13,
            message: {
              content: "",
              role: "assistant",
              tool_calls: [
                {
                  function: { arguments: { path: "b.ts" }, name: "read_file" },
                },
              ],
            },
            prompt_eval_count: 9,
          }),
        ok: true,
      })
      .mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            eval_count: 17,
            message: {
              content: "",
              role: "assistant",
              tool_calls: [
                {
                  function: { arguments: { path: "c.ts" }, name: "read_file" },
                },
              ],
            },
            prompt_eval_count: 11,
          }),
        ok: true,
      });
    vi.stubGlobal("fetch", fetchMock);
    const client = new OllamaClient(createMockConfig(), mockLogger);
    const actualResult = await client.chatCompletionWithTools(
      [{ content: "review", role: "user" }],
      [
        {
          description: "Read file",
          name: "read_file",
          parameters: { properties: {}, required: [], type: "object" },
        },
      ],
      () => Promise.resolve("tool result"),
      { maxToolRounds: 3 },
    );
    expect(actualResult.content).toBeNull();
    expect(actualResult.toolCalls).toEqual([]);
    expect(actualResult.usage).toEqual({
      completionTokens: 41,
      promptTokens: 27,
      toolCalls: 3,
      toolRounds: 3,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        maxRounds: 3,
        toolRounds: [["read_file"], ["read_file"], ["read_file"]],
      }),
      "Tool loop exhausted before final assistant response",
    );
  });
});
