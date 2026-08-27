import { Config } from "~/shared/config";
import { z } from "zod";

import { booleanEnv } from "~/config/boolean-env";
import { DEFAULT_CONTEXT7_MAX_TOKENS } from "~/config/constants";
import { optionalEnv } from "~/config/optional-env";

const Context7ConfigSchema = z.object({
  CONTEXT7_API_KEY: optionalEnv(z.string()),
  CONTEXT7_BASE_URL: z.string().default("https://context7.com"),
  CONTEXT7_ENABLED: booleanEnv(true),
  CONTEXT7_MAX_TOKENS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_CONTEXT7_MAX_TOKENS),
});

type Context7ConfigSchema = z.infer<typeof Context7ConfigSchema>;

class Context7Config extends Config<Context7ConfigSchema> {
  constructor(envs?: Context7ConfigSchema) {
    super(() => envs ?? Context7ConfigSchema.parse(process.env));
  }
}

export { Context7Config, Context7ConfigSchema };
