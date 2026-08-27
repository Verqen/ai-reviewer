import { z } from "zod";

import { optionalEnv } from "~/config/optional-env";

const RuntimeEnvSchema = z.object({
  CODE_HOST_PROVIDER: z.enum(["github", "gitlab"]).default("gitlab"),
  REVIEW_LANGUAGE: optionalEnv(z.string()),
  RULES_FALLBACK_PATH: optionalEnv(z.string()),
  SHOW_REVIEW_COST_FOOTER: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  WORKSPACE_PACKAGE_PREFIXES: z.string().default(""),
});

type RuntimeEnv = z.infer<typeof RuntimeEnvSchema>;

function readRuntimeEnv(): RuntimeEnv {
  return RuntimeEnvSchema.parse(process.env);
}

export { readRuntimeEnv };
export type { RuntimeEnv };
