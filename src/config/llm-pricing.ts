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

/** A pass's token usage, total and (optionally) broken down by model. */
interface PassTokenUsage {
  tokenUsage: { completionTokens: number; promptTokens: number };
  tokenUsageByModel?: Record<
    string,
    { completionTokens: number; promptTokens: number }
  >;
}

/**
 * Total estimated USD cost of a whole review run, summed across passes and
 * models. Per-model usage is canonical when a pass records it; otherwise the
 * pass's total usage is priced at its default model (triage vs review) so cost
 * is never silently dropped. Unknown models price at zero (self-hosted Ollama).
 * Mirrors the orchestrator's per-pass breakdown — one aggregation rule.
 */
function computeReviewRunCostUsd(
  passResults: ReadonlyMap<string, PassTokenUsage>,
  models: { review: string; triage: string },
): number {
  let total = 0;
  for (const [passName, result] of passResults) {
    const byModel = result.tokenUsageByModel ?? {
      [passName === "triage" ? models.triage : models.review]:
        result.tokenUsage,
    };
    for (const [model, usage] of Object.entries(byModel)) {
      total += computeCostUsd(model, {
        inputTokens: usage.promptTokens,
        outputTokens: usage.completionTokens,
      });
    }
  }
  return total;
}

export { computeCostUsd, computeReviewRunCostUsd, getModelPricing, hasPricing };
export type { ModelPricing, PassTokenUsage, TokenCostInput };
