import type { LlmConfig } from "~/config/llm.config";
import {
  OLLAMA_MODEL,
  OLLAMA_TRIAGE_MODEL,
  OPENROUTER_REVIEW_MODEL,
  OPENROUTER_TRIAGE_MODEL,
} from "~/config/models";
import type { OpenRouterConfig } from "~/config/openrouter.config";

export function createMockLlmConfig(options?: {
  ollamaModel?: string;
  ollamaTriageModel?: string;
  provider?: "openrouter" | "ollama";
}): LlmConfig {
  const ollamaModel = options?.ollamaModel ?? OLLAMA_MODEL;
  const ollamaTriageModel = options?.ollamaTriageModel ?? OLLAMA_TRIAGE_MODEL;
  const provider = options?.provider ?? "openrouter";
  return {
    envs: {
      LLM_PROVIDER: provider,
      OLLAMA_BASE_URL: "http://localhost:11434",
      OLLAMA_MODEL: ollamaModel,
      OLLAMA_TRIAGE_MODEL: ollamaTriageModel,
    },
  };
}

export function createMockOpenRouterConfig(options?: {
  model?: string;
  triageModel?: string;
}): OpenRouterConfig {
  return {
    envs: {
      OPENROUTER_API_KEY: "mock-api-key",
      OPENROUTER_MODEL: options?.model ?? OPENROUTER_REVIEW_MODEL,
      OPENROUTER_TRIAGE_MODEL: options?.triageModel ?? OPENROUTER_TRIAGE_MODEL,
    },
  };
}
