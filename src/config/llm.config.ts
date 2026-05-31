import { Config } from "~/shared/config";
import { z } from "zod";

import { OLLAMA_MODEL, OLLAMA_TRIAGE_MODEL } from "~/config/models";

const LlmConfigSchema = z.object({
  LLM_PROVIDER: z.enum(["openrouter", "ollama"]).default("openrouter"),
  OLLAMA_API_KEY: z.string().min(1).optional(),
  OLLAMA_BASE_URL: z.string().default("http://localhost:11434"),
  OLLAMA_MODEL: z.string().default(OLLAMA_MODEL),
  OLLAMA_TRIAGE_MODEL: z.string().default(OLLAMA_TRIAGE_MODEL),
});

type LlmConfigSchema = z.infer<typeof LlmConfigSchema>;

class LlmConfig extends Config<LlmConfigSchema> {
  constructor() {
    super(() => LlmConfigSchema.parse(process.env));
  }
}

export { LlmConfig };
export type { LlmConfigSchema };
