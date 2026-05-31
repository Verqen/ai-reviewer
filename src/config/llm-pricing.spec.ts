import { describe, expect, it } from "vitest";

import { computeCostUsd, getModelPricing, hasPricing } from "./llm-pricing";

describe("llm-pricing", () => {
  describe("hasPricing", () => {
    it("returns true for known models", () => {
      expect(hasPricing("anthropic/claude-sonnet-4.6")).toBe(true);
      expect(hasPricing("minimax/minimax-m2.7")).toBe(true);
    });

    it("returns false for unknown models", () => {
      expect(hasPricing("ollama/qwen3:8b")).toBe(false);
      expect(hasPricing("")).toBe(false);
    });
  });

  describe("getModelPricing", () => {
    it("returns zero pricing for unknown models to avoid crashes", () => {
      expect(getModelPricing("unknown-model")).toEqual({
        cachedInputPerMTokens: 0,
        inputPerMTokens: 0,
        outputPerMTokens: 0,
      });
    });

    it("returns concrete pricing for known models", () => {
      const sonnet = getModelPricing("anthropic/claude-sonnet-4.6");
      expect(sonnet.inputPerMTokens).toBeGreaterThan(0);
      expect(sonnet.outputPerMTokens).toBeGreaterThan(sonnet.inputPerMTokens);
      expect(sonnet.cachedInputPerMTokens).toBeLessThan(sonnet.inputPerMTokens);
    });
  });

  describe("computeCostUsd", () => {
    it("computes uncached input + output cost", () => {
      const cost = computeCostUsd("anthropic/claude-sonnet-4.6", {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      });
      expect(cost).toBeCloseTo(3 + 15);
    });

    it("discounts cached portion of input tokens", () => {
      const withoutCache = computeCostUsd("anthropic/claude-sonnet-4.6", {
        inputTokens: 1_000_000,
        outputTokens: 0,
      });
      const withCache = computeCostUsd("anthropic/claude-sonnet-4.6", {
        cachedInputTokens: 1_000_000,
        inputTokens: 1_000_000,
        outputTokens: 0,
      });
      expect(withCache).toBeLessThan(withoutCache);
      expect(withCache).toBeCloseTo(0.3);
    });

    it("returns zero for unknown models", () => {
      const cost = computeCostUsd("unknown-model", {
        inputTokens: 10_000,
        outputTokens: 10_000,
      });
      expect(cost).toBe(0);
    });

    it("treats negative uncached delta as zero (defensive)", () => {
      const cost = computeCostUsd("anthropic/claude-sonnet-4.6", {
        cachedInputTokens: 2_000_000,
        inputTokens: 1_000_000,
        outputTokens: 0,
      });
      expect(cost).toBeGreaterThanOrEqual(0);
    });
  });
});
