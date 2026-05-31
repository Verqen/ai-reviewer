import { Config } from "~/shared/config";
import { z } from "zod";

import {
  OPENROUTER_REVIEW_MODEL,
  OPENROUTER_TRIAGE_MODEL,
} from "~/config/models";

const OpenRouterConfigSchema = z.object({
  OPENROUTER_API_KEY: z.string(),
  // OpenAI-compatible chat-completions endpoint. Defaults to OpenRouter; point
  // it at any compatible provider (e.g. https://api.deepseek.com/v1/chat/completions)
  // to switch backends without code changes.
  OPENROUTER_API_URL: z
    .url()
    .default("https://openrouter.ai/api/v1/chat/completions"),
  OPENROUTER_MODEL: z.string().default(OPENROUTER_REVIEW_MODEL),
  OPENROUTER_TRIAGE_MODEL: z.string().default(OPENROUTER_TRIAGE_MODEL),
});

type OpenRouterConfigSchema = z.infer<typeof OpenRouterConfigSchema>;

class OpenRouterConfig extends Config<OpenRouterConfigSchema> {
  constructor() {
    super(() => OpenRouterConfigSchema.parse(process.env));
  }
}

export { OpenRouterConfig };
export type { OpenRouterConfigSchema };
