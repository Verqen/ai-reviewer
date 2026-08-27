import { Config } from "~/shared/config";
import { z } from "zod";

import { OLLAMA_MODEL, OLLAMA_TRIAGE_MODEL } from "~/config/models";
import { optionalEnv } from "~/config/optional-env";

const LlmConfigSchema = z.object({
  LLM_PROVIDER: z.enum(["openrouter", "ollama"]).default("openrouter"),
  OLLAMA_API_KEY: optionalEnv(z.string().min(1)),
  OLLAMA_BASE_URL: z.string().default("http://localhost:11434"),
  OLLAMA_MODEL: z.string().default(OLLAMA_MODEL),
  OLLAMA_TRIAGE_MODEL: z.string().default(OLLAMA_TRIAGE_MODEL),
});

type LlmConfigSchema = z.infer<typeof LlmConfigSchema>;

class LlmConfig extends Config<LlmConfigSchema> {
  constructor(envs?: LlmConfigSchema) {
    super(() => envs ?? LlmConfigSchema.parse(process.env));
  }
}

export { LlmConfig, LlmConfigSchema };
