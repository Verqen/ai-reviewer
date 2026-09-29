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
  "deepseek/deepseek-chat": {
    cachedInputPerMTokens: 0.2574,
    inputPerMTokens: 0.2574,
    outputPerMTokens: 1.0287,
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

class UnpricedModelError extends Error {
  constructor(readonly models: readonly string[]) {
    super(
      `A cost ceiling is set but there is no pricing for: ${models.join(", ")}. Spend on these models would count as zero and the ceiling would never trigger.`,
    );
    this.name = "UnpricedModelError";
  }
}

function assertCostCeilingEnforceable(
  models: { review: string; triage: string },
  maxCostUsd: number | undefined,
): void {
  if (maxCostUsd === undefined) return;
  const unpriced = [...new Set([models.review, models.triage])].filter(
    (model) => !hasPricing(model),
  );
  if (unpriced.length > 0) throw new UnpricedModelError(unpriced);
}

interface PricingWarningLogger {
  warn(context: { unpricedModels: string[] }, message: string): void;
}

function reportModelPricing(
  models: readonly string[],
  maxCostUsd: number | undefined,
  logger: PricingWarningLogger,
): void {
  const unpricedModels = [...new Set(models)].filter(
    (model) => !hasPricing(model),
  );
  if (unpricedModels.length === 0) return;
  if (maxCostUsd !== undefined) throw new UnpricedModelError(unpricedModels);
  logger.warn(
    { unpricedModels },
    "No pricing entry for these models: spend is estimated as zero and the cost metrics stay at zero",
  );
}

interface PassTokenUsage {
  tokenUsage: { completionTokens: number; promptTokens: number };
  tokenUsageByModel?: Record<
    string,
    { completionTokens: number; promptTokens: number }
  >;
}

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

export {
  assertCostCeilingEnforceable,
  computeCostUsd,
  computeReviewRunCostUsd,
  getModelPricing,
  hasPricing,
  reportModelPricing,
  UnpricedModelError,
};
export type {
  ModelPricing,
  PassTokenUsage,
  PricingWarningLogger,
  TokenCostInput,
};
