import { z } from "zod";

import { booleanEnv } from "~/config/boolean-env";
import { optionalEnv } from "~/config/optional-env";

type EnvRecord = Record<string, string | undefined>;

const RuntimeEnvSchema = z.object({
  CODE_HOST_PROVIDER: z.enum(["github", "gitlab"]).default("gitlab"),
  REVIEW_LANGUAGE: optionalEnv(z.string()),
  RULES_FALLBACK_PATH: optionalEnv(z.string()),
  SHOW_REVIEW_COST_FOOTER: booleanEnv(false),
  WORKSPACE_PACKAGE_PREFIXES: z.string().default(""),
});

type RuntimeEnv = z.infer<typeof RuntimeEnvSchema>;

function readRuntimeEnv(source: EnvRecord = process.env): RuntimeEnv {
  return RuntimeEnvSchema.parse(source);
}

export { readRuntimeEnv, RuntimeEnvSchema };
export type { EnvRecord, RuntimeEnv };
