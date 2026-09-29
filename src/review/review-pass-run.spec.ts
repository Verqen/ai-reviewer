import { afterEach, describe, expect, it, vi } from "vitest";

import { UnpricedModelError } from "~/config/llm-pricing";
import { createMockLogger } from "~/test-utils/mock-logger";

import { createReviewLlm } from "./review-pass-run";

function useOpenRouter(reviewModel: string): void {
  vi.stubEnv("LLM_PROVIDER", "openrouter");
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  vi.stubEnv("OPENROUTER_MODEL", reviewModel);
  vi.stubEnv("OPENROUTER_TRIAGE_MODEL", "minimax/minimax-m2.7");
}

describe("createReviewLlm", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses a cost ceiling the configured models cannot enforce", () => {
    useOpenRouter("vendor/unpriced");

    expect(() => createReviewLlm(createMockLogger(), 20)).toThrow(
      UnpricedModelError,
    );
  });

  it("builds the client for unpriced models when no ceiling is set", () => {
    useOpenRouter("vendor/unpriced");

    expect(createReviewLlm(createMockLogger(), undefined).models).toEqual({
      review: "vendor/unpriced",
      triage: "minimax/minimax-m2.7",
    });
  });

  it("builds the client under a ceiling when every model is priced", () => {
    useOpenRouter("deepseek/deepseek-chat");

    expect(createReviewLlm(createMockLogger(), 20).models.review).toBe(
      "deepseek/deepseek-chat",
    );
  });
});
