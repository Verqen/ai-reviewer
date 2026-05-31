import type { IConfig } from "~/shared/config";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenRouterConfigSchema } from "~/config/openrouter.config";
import type { ChatMessage } from "~/domain/types/llm.types";
import { OpenRouterClient } from "~/infrastructure/llm/openrouter/openrouter.client";

interface OpenRouterRequestBody {
  max_tokens?: number;
  messages: Array<{
    content:
      | string
      | Array<{
          cache_control?: { ttl: string; type: string };
          text: string;
          type: string;
        }>;
    role: string;
  }>;
  model: string;
  tools?: unknown[];
}

function createMockConfig(): IConfig<OpenRouterConfigSchema> {
  return {
    envs: {
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_API_URL: "https://openrouter.ai/api/v1/chat/completions",
      OPENROUTER_MODEL: "anthropic/claude-sonnet-4-5",
      OPENROUTER_TRIAGE_MODEL: "minimax/minimax-m2.7",
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
  msgPrefix: "",
  silent: vi.fn(),
  trace: vi.fn(),
  warn: vi.fn(),
} as unknown as FastifyBaseLogger;

describe("OpenRouterClient", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes cache_control through to request body for system TextBlock[]", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "{}", role: "assistant" } }],
          usage: { completion_tokens: 5, prompt_tokens: 10 },
        }),
      ok: true,
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenRouterClient(createMockConfig(), mockLogger);
    const messages: ChatMessage[] = [
      {
        content: [
          {
            cacheControl: { ttl: "1h", type: "ephemeral" },
            text: "stable prefix",
            type: "text",
          },
        ],
        role: "system",
      },
      { content: "hi", role: "user" },
    ];

    await client.chatCompletion(messages);

    const callArgs = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(callArgs[1].body) as OpenRouterRequestBody;
    expect(body.messages[0]?.role).toBe("system");
    const systemContent = body.messages[0]?.content;
    expect(Array.isArray(systemContent)).toBe(true);
    const firstBlock = (
      systemContent as OpenRouterRequestBody["messages"][number]["content"] &
        unknown[]
    )[0];
    expect(firstBlock).toMatchObject({
      cache_control: { ttl: "1h", type: "ephemeral" },
      text: "stable prefix",
      type: "text",
    });
  });

  it("keeps system string content as plain string (no cache_control)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "{}", role: "assistant" } }],
          usage: { completion_tokens: 1, prompt_tokens: 1 },
        }),
      ok: true,
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenRouterClient(createMockConfig(), mockLogger);
    await client.chatCompletion([
      { content: "plain system", role: "system" },
      { content: "hi", role: "user" },
    ]);

    const callArgs = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(callArgs[1].body) as OpenRouterRequestBody;
    expect(body.messages[0]?.content).toBe("plain system");
  });

  it("returns null and warns when tool rounds are exhausted", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      function: {
                        arguments: '{"path":"a.ts"}',
                        name: "read_file",
                      },
                      id: "tool-1",
                    },
                  ],
                },
              },
            ],
            usage: { completion_tokens: 13, prompt_tokens: 8 },
          }),
        ok: true,
      })
      .mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      function: {
                        arguments: '{"path":"b.ts"}',
                        name: "read_file",
                      },
                      id: "tool-2",
                    },
                  ],
                },
              },
            ],
            usage: { completion_tokens: 17, prompt_tokens: 9 },
          }),
        ok: true,
      })
      .mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      function: {
                        arguments: '{"path":"c.ts"}',
                        name: "read_file",
                      },
                      id: "tool-3",
                    },
                  ],
                },
              },
            ],
            usage: { completion_tokens: 19, prompt_tokens: 11 },
          }),
        ok: true,
      });
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenRouterClient(createMockConfig(), mockLogger);
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
      completionTokens: 49,
      promptTokens: 28,
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

  it("maps cache_creation_input_tokens and cache_read_input_tokens in usage", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "{}", role: "assistant" } }],
          usage: {
            cache_creation_input_tokens: 1200,
            cache_read_input_tokens: 3400,
            completion_tokens: 50,
            prompt_tokens: 100,
          },
        }),
      ok: true,
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenRouterClient(createMockConfig(), mockLogger);
    const result = await client.chatCompletion([
      { content: "sys", role: "system" },
      { content: "hi", role: "user" },
    ]);

    expect(result.usage.promptTokens).toBe(100);
    expect(result.usage.completionTokens).toBe(50);
    expect(result.usage.cacheCreationInputTokens).toBe(1200);
    expect(result.usage.cacheReadInputTokens).toBe(3400);
  });
});
