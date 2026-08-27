import type { IConfig } from "~/shared/config";

import type { LlmConfigSchema } from "~/config/llm.config";
import type { OpenRouterConfigSchema } from "~/config/openrouter.config";

function resolveDefaultLlmModel(
  llmConfig: IConfig<LlmConfigSchema>,
  openRouterConfig: IConfig<OpenRouterConfigSchema>,
): string {
  if (llmConfig.envs.LLM_PROVIDER === "ollama") {
    return llmConfig.envs.OLLAMA_MODEL;
  }
  return openRouterConfig.envs.OPENROUTER_MODEL;
}

export { resolveDefaultLlmModel };
