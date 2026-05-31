import { describe, expect, it } from "vitest";

import type { ChatMessage, ToolDefinition } from "~/domain/types/llm.types";

import {
  assertPromptTokenBudget,
  estimatePromptTokens,
  PromptTokenBudgetExceededError,
} from "./estimate-prompt-tokens";

describe("estimatePromptTokens", () => {
  it("returns 0 for empty messages and no tools", () => {
    expect(estimatePromptTokens([])).toBe(0);
  });

  it("approximates by ceil(chars/4) for plain user messages", () => {
    const messages: ChatMessage[] = [{ content: "1234567", role: "user" }];
    expect(estimatePromptTokens(messages)).toBe(2);
  });

  it("counts text inside system block array", () => {
    const messages: ChatMessage[] = [
      {
        content: [
          { text: "abcd", type: "text" },
          { text: "efgh", type: "text" },
        ],
        role: "system",
      },
    ];
    expect(estimatePromptTokens(messages)).toBe(3);
  });

  it("includes tool definitions in the estimate", () => {
    const messages: ChatMessage[] = [{ content: "x", role: "user" }];
    const tools: ToolDefinition[] = [
      {
        description: "Reads a file",
        name: "read_file",
        parameters: {
          properties: { path: { type: "string" } },
          type: "object",
        },
      },
    ];
    const without = estimatePromptTokens(messages);
    const withTools = estimatePromptTokens(messages, tools);
    expect(withTools).toBeGreaterThan(without);
  });

  it("handles tool messages and assistant nulls", () => {
    const messages: ChatMessage[] = [
      { content: null, role: "assistant" },
      { content: "tool result", role: "tool", toolCallId: "t1" },
    ];
    expect(estimatePromptTokens(messages)).toBe(
      Math.ceil("tool result".length / 4),
    );
  });
});

describe("assertPromptTokenBudget", () => {
  it("is a no-op when limit is undefined", () => {
    expect(() =>
      assertPromptTokenBudget(
        [{ content: "x".repeat(100_000), role: "user" }],
        undefined,
        undefined,
      ),
    ).not.toThrow();
  });

  it("does not throw when within budget", () => {
    expect(() =>
      assertPromptTokenBudget(
        [{ content: "hello", role: "user" }],
        undefined,
        100,
      ),
    ).not.toThrow();
  });

  it("throws PromptTokenBudgetExceededError when over budget", () => {
    expect(() =>
      assertPromptTokenBudget(
        [{ content: "x".repeat(20_000), role: "user" }],
        undefined,
        4000,
      ),
    ).toThrow(PromptTokenBudgetExceededError);
  });

  it("error exposes estimated and limit fields", () => {
    try {
      assertPromptTokenBudget(
        [{ content: "x".repeat(20_000), role: "user" }],
        undefined,
        4000,
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PromptTokenBudgetExceededError);
      const e = err as PromptTokenBudgetExceededError;
      expect(e.hardLimit).toBe(4000);
      expect(e.estimatedTokens).toBeGreaterThan(4000);
    }
  });
});
