import {
  OPENROUTER_REVIEW_MODEL,
  OPENROUTER_TRIAGE_MODEL,
} from "~/config/models";

interface ModelPricing {
  cachedInputPerMTokens: number;
  inputPerMTokens: number;
  outputPerMTokens: number;
}

const PRICING: Readonly<Record<string, ModelPricing>> = {
  [OPENROUTER_REVIEW_MODEL]: {
    cachedInputPerMTokens: 0.3,
    inputPerMTokens: 3,
    outputPerMTokens: 15,
  },
  [OPENROUTER_TRIAGE_MODEL]: {
    cachedInputPerMTokens: 0.04,
    inputPerMTokens: 0.2,
    outputPerMTokens: 1.1,
  },
};

const ZERO_PRICING: ModelPricing = {
  cachedInputPerMTokens: 0,
  inputPerMTokens: 0,
  outputPerMTokens: 0,
};

function getModelPricing(model: string): ModelPricing {
  return PRICING[model] ?? ZERO_PRICING;
}

interface TokenCostInput {
  cachedInputTokens?: number;
  inputTokens: number;
  outputTokens: number;
}

function computeCostUsd(model: string, usage: TokenCostInput): number {
  const pricing = getModelPricing(model);
  const cachedInput = usage.cachedInputTokens ?? 0;
  const uncachedInput = Math.max(0, usage.inputTokens - cachedInput);
  const perToken = 1 / 1_000_000;
  return (
    uncachedInput * pricing.inputPerMTokens * perToken +
    cachedInput * pricing.cachedInputPerMTokens * perToken +
    usage.outputTokens * pricing.outputPerMTokens * perToken
  );
}

function hasPricing(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(PRICING, model);
}

export { computeCostUsd, getModelPricing, hasPricing };
export type { ModelPricing, TokenCostInput };
