import type { ILlmClient } from "~/domain/ports/llm.port";
import type { LlmOptions } from "~/domain/types/llm.types";
import type { ReviewModels } from "~/review/review-pass-run";

type ProviderPins = Readonly<Record<string, string>>;

class UnpinnedModelError extends Error {
  override readonly name = "UnpinnedModelError";

  constructor(readonly models: readonly string[]) {
    super(
      `A reproducible run needs a pinned provider for: ${models.join(", ")}`,
    );
  }
}

function pinnedProvider(pins: ProviderPins, model: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(pins, model)
    ? pins[model]
    : undefined;
}

function assertModelsPinned(models: ReviewModels, pins: ProviderPins): void {
  const unpinned = [...new Set([models.review, models.triage])].filter(
    (model) => pinnedProvider(pins, model) === undefined,
  );
  if (unpinned.length > 0) throw new UnpinnedModelError(unpinned);
}

function reproducibleOptions(
  options: LlmOptions | undefined,
  defaultModel: string,
  pins: ProviderPins | null,
): LlmOptions {
  const model = options?.model ?? defaultModel;
  const base: LlmOptions = {
    ...options,
    model,
    reasoning: undefined,
    temperature: 0,
  };
  if (pins === null) return base;
  const provider = pinnedProvider(pins, model);
  if (provider === undefined) throw new UnpinnedModelError([model]);
  return { ...base, provider: { allowFallbacks: false, order: [provider] } };
}

function createReproducibleLlm(
  llm: ILlmClient,
  models: ReviewModels,
  pins: ProviderPins | null,
): ILlmClient {
  if (pins !== null) assertModelsPinned(models, pins);
  return {
    chatCompletion: async (messages, options) =>
      llm.chatCompletion(
        messages,
        reproducibleOptions(options, models.review, pins),
      ),
    chatCompletionWithTools: async (messages, tools, toolExecutor, options) =>
      llm.chatCompletionWithTools(
        messages,
        tools,
        toolExecutor,
        reproducibleOptions(options, models.review, pins),
      ),
  };
}

export { createReproducibleLlm, UnpinnedModelError };
export type { ProviderPins };
