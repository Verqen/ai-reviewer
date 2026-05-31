import { describe, expect, it } from "vitest";

import {
  estimateTokens,
  getCacheMinTokens,
  isClaudeModel,
} from "./cache-thresholds";

describe("estimateTokens", () => {
  it("ceils chars / 4", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("x".repeat(4096))).toBe(1024);
  });
});

describe("isClaudeModel", () => {
  it("matches claude in model string regardless of case", () => {
    expect(isClaudeModel("anthropic/claude-sonnet-4-5")).toBe(true);
    expect(isClaudeModel("Claude-Opus")).toBe(true);
    expect(isClaudeModel("openai/gpt-4o")).toBe(false);
    expect(isClaudeModel("ollama/llama-3")).toBe(false);
  });
});

describe("getCacheMinTokens", () => {
  it("returns 1024 for Sonnet 4.5 and 3.5", () => {
    expect(getCacheMinTokens("anthropic/claude-sonnet-4-5")).toBe(1024);
    expect(getCacheMinTokens("anthropic/claude-sonnet-4.5")).toBe(1024);
    expect(getCacheMinTokens("anthropic/claude-3-5-sonnet-20240620")).toBe(
      1024,
    );
  });

  it("returns 2048 for Sonnet 4.6", () => {
    expect(getCacheMinTokens("anthropic/claude-sonnet-4-6")).toBe(2048);
    expect(getCacheMinTokens("anthropic/claude-sonnet-4.6")).toBe(2048);
  });

  it("returns 2048 for Sonnet 4 (4.0) and unknown sonnet variants", () => {
    expect(getCacheMinTokens("anthropic/claude-sonnet-4")).toBe(2048);
    expect(getCacheMinTokens("anthropic/claude-sonnet-5")).toBe(2048);
  });

  it("returns 4096 for Opus and Haiku", () => {
    expect(getCacheMinTokens("anthropic/claude-opus-4")).toBe(4096);
    expect(getCacheMinTokens("anthropic/claude-3-5-haiku")).toBe(4096);
    expect(getCacheMinTokens("anthropic/claude-haiku-4-5")).toBe(4096);
  });

  it("returns null for non-Claude models", () => {
    expect(getCacheMinTokens("openai/gpt-4o-mini")).toBeNull();
    expect(getCacheMinTokens("ollama/llama-3")).toBeNull();
    expect(getCacheMinTokens("google/gemini-2.5")).toBeNull();
  });

  it("falls back to 4096 for unknown Claude variants without sonnet/opus/haiku tokens", () => {
    expect(getCacheMinTokens("anthropic/claude-next")).toBe(4096);
  });
});
